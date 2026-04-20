#!/usr/bin/env node
/* eslint-disable no-console */

const fs = require("node:fs");
const http = require("node:http");
const os = require("node:os");
const path = require("node:path");
const { spawnSync } = require("node:child_process");
const {
  CHROME_EXE,
  DEFAULT_CDP_PORT,
  DEFAULT_PWCLI_SESSION,
  USER_DATA_DIR,
  BACKUP_ROOT,
} = require("./config");
const {
  checkForUpdate,
  installRepo,
} = require("./update");
const {
  activateTab,
  clickTab,
  closeTab,
  evalTab,
  fillTab,
  gotoTab,
  inspectFields,
  listFrames,
  listTabs,
  pruneDuplicateTabs,
  saveAndCloseBrowser,
  screenshotTab,
  snapshotTab,
  textTab,
  reuseOrOpenTab,
} = require("./tab_tools");

const ROOT = __dirname;
const SELF_REPO = process.env.PBC_GITHUB_REPO || "gaston1799/persistent-browser-cli";
const PBC_VERSION = process.env.PBC_VERSION || "0.0.0";
let seaApi = null;

try {
  seaApi = require("node:sea");
} catch {}

function usage(exitCode = 0) {
  const txt = `
persistent-browser-cli

Usage:
  pbc open [url] [--port 9222] [--reuse] [--match "<text>"] [--tab <id>]
  pbc cdp [--port 9222]
  pbc doctor [--port 9222]
  pbc saveandclose [--port 9222]
  pbc sac [--port 9222]
  pbc backup [--kill]
  pbc update [--check-only] [--port 9222]
  pbc install [--repo-url <url>] [--install-root <path>] [--link-global] [--clone-stable-chrome-profile]

  pbc tab list [--all] [--port 9222]
  pbc tab activate <id|match> [--port 9222]
  pbc tab goto <id|match|active> <url> [--port 9222]
  pbc tab close <id|match> [--port 9222]
  pbc tab frames <id|match|active> [--port 9222]
  pbc tab inspect <id|match|active> [--frame <name-or-url>] [--port 9222]
  pbc tab snapshot <id|match|active> [--frame <name-or-url>] [--json] [--port 9222]
  pbc tab text <id|match|active> [--frame <name-or-url>] [--json] [--port 9222]
  pbc tab click <id|match|active> <ref|selector|text> [--frame <name-or-url>] [--port 9222]
  pbc tab fill <id|match|active> <ref|selector|label> <value> [--frame <name-or-url>] [--port 9222]
  pbc tab screenshot <id|match|active> [path] [--full-page] [--port 9222]
  pbc tab eval <id|match|active> <javascript> [--frame <name-or-url>] [--json] [--port 9222]
  pbc tab prune [--port 9222] [--keep <id|match>]

  pbc pw <playwright-cli args...>

Environment overrides:
  PBC_CHROME_EXE
  PBC_USER_DATA_DIR
  PBC_BACKUP_ROOT
  PBC_CDP_PORT
  PBC_OPEN_TIMEOUT_MS
  PBC_PWCLI_SESSION
  PBC_GITHUB_REPO
  PBC_SKIP_UPDATE_CHECK

Defaults:
  chromeExe:   ${CHROME_EXE}
  userDataDir: ${USER_DATA_DIR}
  backupRoot:  ${BACKUP_ROOT}
`.trim();
  console.log(txt);
  process.exit(exitCode);
}

function readArg(flag, argv) {
  const idx = argv.indexOf(flag);
  if (idx === -1) return null;
  const value = argv[idx + 1];
  if (!value || value.startsWith("-")) return null;
  return value;
}

function hasFlag(flag, argv) {
  return argv.includes(flag);
}

function positionalArgs(argv) {
  const result = [];
  for (let i = 0; i < argv.length; i += 1) {
    const value = argv[i];
    if (value === "--port" || value === "--frame" || value === "--keep" || value === "--match" || value === "--tab") {
      i += 1;
      continue;
    }
    if (value === "--json" || value === "--full-page" || value === "--all" || value === "--reuse") {
      continue;
    }
    if (String(value || "").startsWith("--")) {
      continue;
    }
    result.push(value);
  }
  return result;
}

function readOption(flag, argv, defaultValue = null) {
  const value = readArg(flag, argv);
  return value == null ? defaultValue : value;
}

function formatStatus(ok, label, detail) {
  return `[${ok ? "OK" : "WARN"}] ${label}: ${detail}`;
}

function formatInfo(label, detail) {
  return `[INFO] ${label}: ${detail}`;
}

function findCommand(command) {
  const result = spawnSync("where.exe", [command], {
    encoding: "utf8",
    windowsHide: true,
  });
  if ((result.status ?? 1) !== 0) return [];
  return String(result.stdout || "")
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);
}

function getProfileLockFiles(userDataDir) {
  const names = ["SingletonLock", "SingletonCookie", "SingletonSocket"];
  return names.filter((name) => fs.existsSync(path.join(userDataDir, name)));
}

async function isCdpUp(port) {
  return new Promise((resolve) => {
    const req = http.request(
      { method: "GET", host: "127.0.0.1", port, path: "/json/version", timeout: 700 },
      (res) => {
        res.resume();
        resolve(res.statusCode === 200);
      }
    );
    req.on("timeout", () => {
      req.destroy();
      resolve(false);
    });
    req.on("error", () => resolve(false));
    req.end();
  });
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function normalizeTargetUrl(value) {
  try {
    const url = new URL(value);
    url.hash = "";
    if (url.pathname !== "/" && url.pathname.endsWith("/")) {
      url.pathname = url.pathname.replace(/\/+$/, "");
    }
    return url.toString();
  } catch {
    return String(value || "").trim();
  }
}

function isChromeSystemUrl(value) {
  const url = String(value || "").toLowerCase();
  return (
    url.startsWith("chrome://") ||
    url.startsWith("devtools://") ||
    url.startsWith("edge://") ||
    url.startsWith("chrome-extension://")
  );
}

function targetMatchesOpenUrl(target, requestedUrl) {
  const targetUrl = String(target?.url || "");
  if (!targetUrl) return false;
  if (normalizeTargetUrl(targetUrl) === normalizeTargetUrl(requestedUrl)) return true;
  return !isChromeSystemUrl(targetUrl);
}

async function fetchCdpPageTargets(port) {
  const response = await fetch(`http://127.0.0.1:${port}/json/list`);
  if (!response.ok) return [];
  const targets = await response.json();
  return targets.filter((target) => target.type === "page");
}

async function waitForOpenReady(port, requestedUrl, timeoutMs = 120000) {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    try {
      if (await isCdpUp(port)) {
        const pages = await fetchCdpPageTargets(port);
        if (pages.some((target) => targetMatchesOpenUrl(target, requestedUrl))) return true;
      }
    } catch {
      // Chrome can accept the version request before the target list is ready.
    }
    await sleep(500);
  }
  return false;
}

async function countCdpPageTargets(port) {
  const response = await fetch(`http://127.0.0.1:${port}/json/list`);
  if (!response.ok) {
    throw new Error(`Could not read CDP target list on port ${port}.`);
  }
  const targets = await response.json();
  return targets.filter((target) => target.type === "page").length;
}

function runPwsh(ps1, args = []) {
  const script = resolveScriptPath(ps1);
  const result = spawnSync(
    "powershell",
    ["-NoProfile", "-ExecutionPolicy", "Bypass", "-File", script, ...args],
    { stdio: "inherit", cwd: ROOT }
  );
  return result.status ?? 1;
}

function currentVersion() {
  if (PBC_VERSION && PBC_VERSION !== "0.0.0") {
    return PBC_VERSION;
  }
  try {
    const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, "package.json"), "utf8"));
    return String(pkg.version || "0.0.0");
  } catch {
    return "0.0.0";
  }
}

async function maybePrintUpdateNotice() {
  if (process.env.PBC_SKIP_UPDATE_CHECK) return;
  try {
    const info = await checkForUpdate({ repoFullName: SELF_REPO, currentVersion: currentVersion() });
    if (info.updateAvailable) {
      console.log(`[pbc] Update available: v${info.currentVersion} -> v${info.latestVersion}`);
      console.log(`[pbc] Run \`pbc update\` to install the latest release.`);
    }
  } catch {
    // Non-blocking by design.
  }
}

async function updateSelf(checkOnly = false) {
  const info = await checkForUpdate({ repoFullName: SELF_REPO, currentVersion: currentVersion() });
  console.log(`[pbc] Current version: v${info.currentVersion}`);
  console.log(`[pbc] Latest release:  ${info.latestTag || `v${info.latestVersion}`}`);
  if (!info.releaseUrl) {
    console.log("[pbc] Could not determine the latest release URL.");
  } else {
    console.log(`[pbc] Release URL:     ${info.releaseUrl}`);
  }

  if (!info.updateAvailable) {
    console.log("[pbc] Already up to date.");
    return 0;
  }

  if (checkOnly) {
    console.log("[pbc] Update available, but no changes were made because --check-only was set.");
    return 0;
  }

  const gitResult = spawnSync("git", ["rev-parse", "--is-inside-work-tree"], {
    cwd: ROOT,
    encoding: "utf8",
    windowsHide: true,
  });
  if ((gitResult.status ?? 1) !== 0) {
    console.log("[pbc] This install is not a git checkout. Use the release asset or rerun the installer in a cloned repo.");
    return 1;
  }

  console.log("[pbc] Pulling the latest tagged release into this checkout...");
  const status = installRepo({ repoDir: ROOT });
  if (status !== 0) {
    console.log(`[pbc] Update failed with exit code ${status}.`);
    return status;
  }

  console.log("[pbc] Update complete.");
  return 0;
}

function isSeaRuntime() {
  return Boolean(seaApi && typeof seaApi.isSea === "function" && seaApi.isSea());
}

function resolveScriptPath(ps1) {
  if (!isSeaRuntime()) {
    return path.join(ROOT, ps1);
  }

  const tempRoot = path.join(os.tmpdir(), "persistent-browser-cli-sea");
  fs.mkdirSync(tempRoot, { recursive: true });
  const targetPath = path.join(tempRoot, ps1);
  if (!fs.existsSync(targetPath)) {
    const asset = seaApi.getAsset(ps1);
    if (!asset) {
      throw new Error(`Embedded SEA asset not found: ${ps1}`);
    }
    fs.writeFileSync(targetPath, Buffer.from(asset));
  }
  return targetPath;
}

function runPlaywrightCli(args) {
  const localPwCli = path.join(ROOT, "node_modules", "@playwright", "cli", "playwright-cli.js");
  const hasLocal = fs.existsSync(localPwCli);
  const hasSession = args.some((a) => a === "-s" || String(a).startsWith("-s=") || a === "--session" || String(a).startsWith("--session="));

  const sub = args[0];
  if (sub === "open") {
    const hasBrowser = args.some((a) => a === "--browser" || String(a).startsWith("--browser="));
    const hasHeaded = args.includes("--headed");
    if (!hasBrowser) args = [...args, "--browser", "chrome"];
    if (!hasHeaded) args = [...args, "--headed"];
  }

  const runArgs = hasSession ? args : [`-s=${DEFAULT_PWCLI_SESSION}`, ...args];
  let result;
  if (hasLocal) {
    result = spawnSync(process.execPath, [localPwCli, ...runArgs], { stdio: "inherit", cwd: ROOT });
  } else {
    result = spawnSync(process.platform === "win32" ? "npx.cmd" : "npx", ["--yes", "--package", "@playwright/cli", "playwright-cli", ...runArgs], {
      stdio: "inherit",
      cwd: ROOT,
    });
  }
  if (result.error) {
    console.error("[pbc] Failed to run Playwright CLI:", result.error.message || result.error);
  }
  return result.status ?? 1;
}

function printJson(value) {
  console.log(JSON.stringify(value, null, 2));
}

function renderSnapshot(info) {
  console.log(`[pbc] Tab: [${info.tab.id}] ${info.tab.url}`);
  console.log(`[pbc] Frame: ${info.frame.name || "(no name)"} | ${info.frame.url}`);
  if (!info.items.length) {
    console.log("[pbc] No visible interactive elements found.");
    return;
  }

  for (const item of info.items) {
    const bits = [
      `[${item.ref}]`,
      item.tag,
      item.type ? `type=${item.type}` : null,
      item.role ? `role=${item.role}` : null,
      item.disabled ? "disabled" : null,
      item.name ? `name=${item.name}` : null,
      item.id ? `id=${item.id}` : null,
      item.label ? `label=${JSON.stringify(item.label)}` : null,
      item.value && item.tag !== "button" ? `value=${JSON.stringify(item.value)}` : null,
    ].filter(Boolean);
    console.log(bits.join(" | "));
  }
}

function defaultScreenshotPath() {
  const outDir = path.join(ROOT, "output");
  fs.mkdirSync(outDir, { recursive: true });
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  return path.join(outDir, `pbc-screenshot-${stamp}.png`);
}

async function main() {
  const argv = process.argv.slice(2);
  if (argv.length === 0) usage(0);
  if (argv[0] === "-h" || argv[0] === "-help" || argv[0] === "--help") usage(0);

  await maybePrintUpdateNotice();

  const cmd = argv[0];

  if (cmd === "open") {
    const url = argv[1] && !argv[1].startsWith("-") ? argv[1] : "https://example.com";
    const port = Number(readArg("--port", argv) || DEFAULT_CDP_PORT);
    const reuse = hasFlag("--reuse", argv);
    const match = readArg("--match", argv);
    const tab = readArg("--tab", argv);
    const up = await isCdpUp(port);
    if (up) {
      const reused = await reuseOrOpenTab(port, url, {
        match,
        token: tab,
        reuseActive: reuse,
      });
      if (reused) {
        console.log(`[pbc] ${reused.mode === "exact" ? "Focused existing tab" : "Reused tab"} [${reused.id}] ${reused.url}`);
        process.exit(0);
      }
    }

    const launchStatus = runPwsh("open_persistent_chrome.ps1", [
      "-Url",
      url,
      "-RemoteDebuggingPort",
      String(port),
      "-ChromeExe",
      CHROME_EXE,
      "-UserDataDir",
      USER_DATA_DIR,
    ]);
    if (launchStatus !== 0) process.exit(launchStatus);

    const openTimeoutMs = Number(process.env.PBC_OPEN_TIMEOUT_MS || 120000);
    const ready = await waitForOpenReady(port, url, openTimeoutMs);
    if (!ready) {
      console.error(`[pbc] Timed out waiting for a usable CDP page target at http://127.0.0.1:${port}.`);
      process.exit(2);
    }

    console.log(`CDP: UP (http://127.0.0.1:${port})`);
    process.exit(0);
  }

  if (cmd === "cdp") {
    const port = Number(readArg("--port", argv) || DEFAULT_CDP_PORT);
    const up = await isCdpUp(port);
    if (up) {
      console.log(`CDP: UP (http://127.0.0.1:${port})`);
      process.exit(0);
    }
    console.log(`CDP: DOWN (http://127.0.0.1:${port})`);
    process.exit(2);
  }

  if (cmd === "doctor") {
    const port = Number(readArg("--port", argv) || DEFAULT_CDP_PORT);
    const lines = [];
    let hardFailures = 0;

    const chromeExists = fs.existsSync(CHROME_EXE);
    lines.push(formatStatus(chromeExists, "chrome executable", chromeExists ? CHROME_EXE : `${CHROME_EXE} (not found)`));
    if (!chromeExists) hardFailures += 1;

    const profileExists = fs.existsSync(USER_DATA_DIR);
    lines.push(
      formatStatus(
        profileExists,
        "user data dir",
        profileExists ? USER_DATA_DIR : `${USER_DATA_DIR} (will be created on first launch)`
      )
    );

    const backupExists = fs.existsSync(BACKUP_ROOT);
    lines.push(
      formatStatus(
        backupExists,
        "backup root",
        backupExists ? BACKUP_ROOT : `${BACKUP_ROOT} (missing until first backup)`
      )
    );

    const cdpUp = await isCdpUp(port);
    lines.push(formatStatus(cdpUp, "cdp endpoint", `http://127.0.0.1:${port} ${cdpUp ? "is reachable" : "is down"}`));

    if (cdpUp) {
      try {
        const tabs = await countCdpPageTargets(port);
        lines.push(formatInfo("open tabs", `${tabs}`));
      } catch (error) {
        lines.push(formatStatus(false, "open tabs", error.message || String(error)));
      }
    }

    const lockFiles = getProfileLockFiles(USER_DATA_DIR);
    if (cdpUp) {
      lines.push(formatStatus(true, "profile ownership", `profile is attached to the active CDP browser on port ${port}`));
    } else if (lockFiles.length) {
      lines.push(formatStatus(true, "profile ownership", `profile lock files are present: ${lockFiles.join(", ")}`));
    } else {
      lines.push(formatStatus(false, "profile ownership", "could not confirm active use; CDP is down and no profile lock files were found"));
    }

    const pbcHits = findCommand("pbc");
    const pbcCliHits = findCommand("pbc-cli");
    const fullHits = findCommand("persistent-browser-cli");
    lines.push(formatStatus(pbcHits.length > 0, "command shim pbc", pbcHits[0] || "not found in PATH"));
    lines.push(formatStatus(pbcCliHits.length > 0, "command shim pbc-cli", pbcCliHits[0] || "not found in PATH"));
    lines.push(formatStatus(fullHits.length > 0, "command shim persistent-browser-cli", fullHits[0] || "not found in PATH"));
    lines.push(formatInfo("powershell alias note", "`cli` collides with Clear-Item, so use `pbc` or `pbc-cli`"));

    console.log("persistent-browser-cli doctor");
    console.log(`Defaults: port=${port} | session=${DEFAULT_PWCLI_SESSION}`);
    for (const line of lines) console.log(line);
    process.exit(hardFailures ? 1 : 0);
  }

  if (cmd === "saveandclose" || cmd === "sac") {
    const port = Number(readArg("--port", argv) || DEFAULT_CDP_PORT);
    const up = await isCdpUp(port);
    if (!up) {
      console.log(`CDP: DOWN (http://127.0.0.1:${port})`);
      return 2;
    }

    const result = await saveAndCloseBrowser(port);
    if (result.closedTabs.length) {
      console.log(`[pbc] Closed ${result.closedTabs.length} tab(s) before Browser.close.`);
    } else {
      console.log("[pbc] No tabs were open, but Browser.close was still requested.");
    }
    if (result.browserClose?.alreadyClosed) {
      console.log("[pbc] Chrome exited after the tab shutdown, so Browser.close was not needed.");
    }

    for (let i = 0; i < 20; i += 1) {
      if (!(await isCdpUp(port))) {
        console.log("[pbc] Browser closed cleanly and the persistent profile should be flushed to disk.");
        return 0;
      }
      await new Promise((resolve) => setTimeout(resolve, 250));
    }

    console.log("[pbc] Browser.close was requested, but CDP still appears up. You may need to close Chrome manually.");
    return 1;
  }

  if (cmd === "backup") {
    const kill = hasFlag("--kill", argv);
    process.exit(runPwsh("backup_profile.ps1", [
      "-SourceDir",
      USER_DATA_DIR,
      "-BackupRoot",
      BACKUP_ROOT,
      ...(kill ? ["-KillChrome"] : []),
    ]));
  }

  if (cmd === "install") {
    if (argv.includes("-h") || argv.includes("--help")) {
      console.log("Usage: pbc install [--repo-url <url>] [--install-root <path>] [--link-global] [--clone-stable-chrome-profile]");
      process.exit(0);
    }
    const repoUrl = readOption("--repo-url", argv, "https://github.com/gaston1799/persistent-browser-cli.git");
    const installRoot = readOption("--install-root", argv, path.join(os.homedir(), "AppData", "Local", "persistent-browser-cli"));
    const args = [
      "-RepoUrl",
      repoUrl,
      "-InstallRoot",
      installRoot,
    ];
    if (hasFlag("--link-global", argv)) args.push("-LinkGlobal");
    if (hasFlag("--clone-stable-chrome-profile", argv)) args.push("-CloneStableChromeProfile");
    process.exit(runPwsh("install.ps1", args));
  }

  if (cmd === "update") {
    const checkOnly = hasFlag("--check-only", argv);
    const status = await updateSelf(checkOnly);
    process.exit(status);
  }

  if (cmd === "tab") {
    const sub = argv[1];
    const port = Number(readArg("--port", argv) || DEFAULT_CDP_PORT);
    if (!(await isCdpUp(port))) {
      console.log(`CDP: DOWN (http://127.0.0.1:${port})`);
      process.exit(2);
    }

    if (sub === "list") {
      const tabs = await listTabs(port, { includeInternal: hasFlag("--all", argv) });
      if (!tabs.length) {
        console.log("[pbc] No tabs found.");
        process.exit(0);
      }
      for (const tabInfo of tabs) console.log(tabInfo.label);
      process.exit(0);
    }

    if (sub === "activate") {
      const token = argv[2];
      if (!token || token.startsWith("-")) {
        console.log("Usage: pbc tab activate <id|match> [--port 9222]");
        process.exit(1);
      }
      const result = await activateTab(port, token);
      console.log(`[pbc] Focused tab [${result.id}] ${result.url}`);
      process.exit(0);
    }

    if (sub === "goto") {
      const token = argv[2];
      const url = argv[3];
      if (!token || token.startsWith("-") || !url || url.startsWith("-")) {
        console.log("Usage: pbc tab goto <id|match|active> <url> [--port 9222]");
        process.exit(1);
      }
      const result = await gotoTab(port, token, url);
      console.log(`[pbc] Reused tab [${result.id}] ${result.url}`);
      process.exit(0);
    }

    if (sub === "close") {
      const token = argv[2];
      if (!token || token.startsWith("-")) {
        console.log("Usage: pbc tab close <id|match> [--port 9222]");
        process.exit(1);
      }
      const result = await closeTab(port, token);
      console.log(`[pbc] Closed tab [${result.id}] ${result.url}`);
      process.exit(0);
    }

    if (sub === "frames") {
      const token = argv[2];
      if (!token || token.startsWith("-")) {
        console.log("Usage: pbc tab frames <id|match|active> [--port 9222]");
        process.exit(1);
      }
      const frames = await listFrames(port, token);
      for (const frame of frames) {
        const element = frame.element
          ? [
              frame.element.id ? `id=${frame.element.id}` : null,
              frame.element.name ? `name=${frame.element.name}` : null,
              frame.element.src ? `src=${frame.element.src}` : null,
            ].filter(Boolean).join(" | ")
          : "";
        console.log(`${frame.isMain ? "*" : " "} [${frame.index}] ${frame.name || "(no name)"} | ${frame.url}${element ? ` | ${element}` : ""}`);
      }
      process.exit(0);
    }

    if (sub === "inspect") {
      const token = argv[2];
      const frame = readArg("--frame", argv);
      if (!token || token.startsWith("-")) {
        console.log("Usage: pbc tab inspect <id|match|active> [--frame <name-or-url>] [--port 9222]");
        process.exit(1);
      }
      const info = await inspectFields(port, token, { frame });
      console.log(`[pbc] Frame: ${info.frame.name || "(no name)"} | ${info.frame.url}`);
      for (const control of info.controls) {
        const parts = [
          `[${control.index}]`,
          `${control.tag}/${control.type}`,
          control.required ? "required" : null,
          control.disabled ? "disabled" : null,
          control.name ? `name=${control.name}` : null,
          control.id ? `id=${control.id}` : null,
          control.label ? `label=${JSON.stringify(control.label)}` : null,
          control.placeholder ? `placeholder=${JSON.stringify(control.placeholder)}` : null,
          control.value ? `value=${JSON.stringify(control.value)}` : null,
          control.text && !control.value ? `text=${JSON.stringify(control.text)}` : null,
        ].filter(Boolean);
        console.log(parts.join(" | "));
      }
      process.exit(0);
    }

    if (sub === "snapshot") {
      const args = positionalArgs(argv.slice(2));
      const token = args[0];
      const frame = readArg("--frame", argv);
      if (!token || token.startsWith("-")) {
        console.log("Usage: pbc tab snapshot <id|match|active> [--frame <name-or-url>] [--json] [--port 9222]");
        process.exit(1);
      }
      const info = await snapshotTab(port, token, { frame });
      if (hasFlag("--json", argv)) printJson(info);
      else renderSnapshot(info);
      process.exit(0);
    }

    if (sub === "text") {
      const args = positionalArgs(argv.slice(2));
      const token = args[0];
      const frame = readArg("--frame", argv);
      if (!token || token.startsWith("-")) {
        console.log("Usage: pbc tab text <id|match|active> [--frame <name-or-url>] [--json] [--port 9222]");
        process.exit(1);
      }
      const info = await textTab(port, token, { frame });
      if (hasFlag("--json", argv)) printJson(info);
      else {
        console.log(`[pbc] Frame: ${info.frame.name || "(no name)"} | ${info.frame.url}`);
        console.log(info.text);
      }
      process.exit(0);
    }

    if (sub === "click") {
      const args = positionalArgs(argv.slice(2));
      const token = args[0];
      const target = args.slice(1).join(" ");
      const frame = readArg("--frame", argv);
      if (!token || !target) {
        console.log("Usage: pbc tab click <id|match|active> <ref|selector|text> [--frame <name-or-url>] [--port 9222]");
        process.exit(1);
      }
      const result = await clickTab(port, token, target, { frame });
      console.log(`[pbc] Clicked ${result.mode} ${JSON.stringify(result.clicked)}.`);
      process.exit(0);
    }

    if (sub === "fill") {
      const args = positionalArgs(argv.slice(2));
      const token = args[0];
      const target = args[1];
      const value = args.slice(2).join(" ");
      const frame = readArg("--frame", argv);
      if (!token || !target || value.length === 0) {
        console.log("Usage: pbc tab fill <id|match|active> <ref|selector|label> <value> [--frame <name-or-url>] [--port 9222]");
        process.exit(1);
      }
      const result = await fillTab(port, token, target, value, { frame });
      console.log(`[pbc] Filled ${result.mode} ${JSON.stringify(result.filled)} using ${result.method}.`);
      process.exit(0);
    }

    if (sub === "screenshot") {
      const args = positionalArgs(argv.slice(2));
      const token = args[0];
      const outputPath = path.resolve(args[1] || defaultScreenshotPath());
      if (!token || token.startsWith("-")) {
        console.log("Usage: pbc tab screenshot <id|match|active> [path] [--full-page] [--port 9222]");
        process.exit(1);
      }
      fs.mkdirSync(path.dirname(outputPath), { recursive: true });
      const result = await screenshotTab(port, token, outputPath, { fullPage: hasFlag("--full-page", argv) });
      console.log(`[pbc] Screenshot saved: ${result.path}`);
      process.exit(0);
    }

    if (sub === "eval") {
      const args = positionalArgs(argv.slice(2));
      const token = args[0];
      const source = args.slice(1).join(" ");
      const frame = readArg("--frame", argv);
      if (!token || !source) {
        console.log("Usage: pbc tab eval <id|match|active> <javascript> [--frame <name-or-url>] [--json] [--port 9222]");
        process.exit(1);
      }
      const result = await evalTab(port, token, source, { frame });
      if (hasFlag("--json", argv)) printJson(result);
      else if (typeof result.value === "string") console.log(result.value);
      else printJson(result.value);
      process.exit(0);
    }

    if (sub === "prune") {
      const keep = readArg("--keep", argv);
      const closed = await pruneDuplicateTabs(port, keep);
      if (!closed.length) {
        console.log("[pbc] No exact-duplicate tabs found.");
        process.exit(0);
      }
      for (const tabInfo of closed) console.log(`[pbc] Closed duplicate [${tabInfo.id}] ${tabInfo.url}`);
      process.exit(0);
    }

    usage(1);
  }

  if (cmd === "pw") {
    const args = argv.slice(1);
    if (args.length === 0) {
      console.log("Pass Playwright CLI args, e.g.: pbc pw open https://example.com");
      process.exit(1);
    }
    const status = runPlaywrightCli(args);
    const maybeRef = args.find((a) => /^e\d+$/i.test(String(a)));
    const isRefCommand = ["click", "dblclick", "fill", "hover", "check", "uncheck", "select", "drag", "screenshot"].includes(String(args[0] || "").toLowerCase());
    if (status !== 0 && isRefCommand && maybeRef) {
      console.log("");
      console.log(`[pbc] Command failed on ref ${maybeRef}. Taking a fresh snapshot so you can retry with new refs...`);
      runPlaywrightCli(["snapshot"]);
    }
    process.exit(status);
  }

  usage(1);
}

main()
  .then((code) => {
    if (typeof code === "number") process.exitCode = code;
  })
  .catch((error) => {
  console.error(error);
  process.exit(1);
  });
