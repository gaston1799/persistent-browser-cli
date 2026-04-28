#!/usr/bin/env node
/* eslint-disable no-console */

const fs = require("node:fs");
const http = require("node:http");
const os = require("node:os");
const path = require("node:path");
const readline = require("node:readline/promises");
const { spawnSync } = require("node:child_process");
const {
  CHROME_EXE,
  DATA_ROOT,
  DEFAULT_CDP_PORT,
  DEFAULT_PWCLI_SESSION,
  USER_DATA_DIR,
  USER_DATA_DIR_IS_DEFAULT,
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
  pbc open [url] [--port 9222] [--reuse] [--match "<text>"] [--tab <id>] [--profile-source stable|beta|dev|canary|empty|<path>] [--no-profile-clone]
  pbc cdp [--port 9222]
  pbc doctor [--port 9222]
  pbc saveandclose [--port 9222]
  pbc sac [--port 9222]
  pbc backup [--kill]
  pbc update [--check-only] [--port 9222]
  pbc install [--repo-url <url>] [--install-root <path>] [--link-global] [--clone-stable-chrome-profile]

  pbc tab list [--all] [--port 9222]
  pbc tab activate <id|match> [--port 9222]
  pbc tab goto <id|match|active> <url> [--trace] [--trace-dir <path>] [--port 9222]
  pbc tab close <id|match> [--port 9222]
  pbc tab frames <id|match|active> [--port 9222]
  pbc tab inspect <id|match|active> [--frame <name-or-url>] [--port 9222]
  pbc tab snapshot <id|match|active> [--frame <name-or-url>] [--json] [--trace] [--trace-dir <path>] [--port 9222]
  pbc tab text <id|match|active> [--frame <name-or-url>] [--json] [--trace] [--trace-dir <path>] [--port 9222]
  pbc tab click <id|match|active> <ref|selector|text> [--frame <name-or-url>] [--trace] [--trace-dir <path>] [--port 9222]
  pbc tab fill <id|match|active> <ref|selector|label> <value> [--frame <name-or-url>] [--trace] [--trace-dir <path>] [--port 9222]
  pbc tab screenshot <id|match|active> [path] [--full-page] [--trace] [--trace-dir <path>] [--port 9222]
  pbc tab eval <id|match|active> <javascript> [--frame <name-or-url>] [--json] [--trace] [--trace-dir <path>] [--port 9222]
  pbc tab prune [--port 9222] [--keep <id|match>]

  pbc trace list
  pbc trace latest

  pbc pw <playwright-cli args...>

Environment overrides:
  PBC_CHROME_EXE
  PBC_DATA_ROOT
  PBC_USER_DATA_DIR
  PBC_BACKUP_ROOT
  PBC_CDP_PORT
  PBC_OPEN_TIMEOUT_MS
  PBC_PWCLI_SESSION
  PBC_GITHUB_REPO
  PBC_SKIP_UPDATE_CHECK

Defaults:
  chromeExe:   ${CHROME_EXE}
  dataRoot:    ${DATA_ROOT}
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
    if (value === "--port" || value === "--frame" || value === "--keep" || value === "--match" || value === "--tab" || value === "--trace-dir") {
      i += 1;
      continue;
    }
    if (value === "--json" || value === "--full-page" || value === "--all" || value === "--reuse" || value === "--trace") {
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

function chromeChannels() {
  const localAppData = process.env.LOCALAPPDATA || path.join(os.homedir(), "AppData", "Local");
  const programFiles = process.env.PROGRAMFILES || "C:\\Program Files";
  const programFilesX86 = process.env["PROGRAMFILES(X86)"] || "C:\\Program Files (x86)";
  return [
    {
      id: "stable",
      label: "Google Chrome Stable",
      exeCandidates: [
        path.join(programFiles, "Google", "Chrome", "Application", "chrome.exe"),
        path.join(programFilesX86, "Google", "Chrome", "Application", "chrome.exe"),
        path.join(localAppData, "Google", "Chrome", "Application", "chrome.exe"),
      ],
      userDataDir: path.join(localAppData, "Google", "Chrome", "User Data"),
    },
    {
      id: "beta",
      label: "Google Chrome Beta",
      exeCandidates: [
        path.join(programFiles, "Google", "Chrome Beta", "Application", "chrome.exe"),
        path.join(programFilesX86, "Google", "Chrome Beta", "Application", "chrome.exe"),
        path.join(localAppData, "Google", "Chrome Beta", "Application", "chrome.exe"),
      ],
      userDataDir: path.join(localAppData, "Google", "Chrome Beta", "User Data"),
    },
    {
      id: "dev",
      label: "Google Chrome Dev",
      exeCandidates: [
        path.join(programFiles, "Google", "Chrome Dev", "Application", "chrome.exe"),
        path.join(programFilesX86, "Google", "Chrome Dev", "Application", "chrome.exe"),
        path.join(localAppData, "Google", "Chrome Dev", "Application", "chrome.exe"),
      ],
      userDataDir: path.join(localAppData, "Google", "Chrome Dev", "User Data"),
    },
    {
      id: "canary",
      label: "Google Chrome Canary",
      exeCandidates: [
        path.join(localAppData, "Google", "Chrome SxS", "Application", "chrome.exe"),
        path.join(programFiles, "Google", "Chrome SxS", "Application", "chrome.exe"),
      ],
      userDataDir: path.join(localAppData, "Google", "Chrome SxS", "User Data"),
    },
  ].map((channel) => ({
    ...channel,
    exe: channel.exeCandidates.find((candidate) => fs.existsSync(candidate)) || channel.exeCandidates[0],
    installed: channel.exeCandidates.some((candidate) => fs.existsSync(candidate)) || fs.existsSync(channel.userDataDir),
    hasProfile: fs.existsSync(channel.userDataDir),
  }));
}

function resolveProfileSource(value) {
  const raw = String(value || "").trim();
  if (!raw) return null;
  if (/^empty$/i.test(raw)) return { mode: "empty" };
  const channel = chromeChannels().find((candidate) => candidate.id === raw.toLowerCase());
  if (channel) return { mode: "clone", ...channel };
  return { mode: "clone", id: "custom", label: "Custom Chrome profile", userDataDir: path.resolve(raw), hasProfile: fs.existsSync(path.resolve(raw)) };
}

async function promptProfileSource(candidates) {
  if (!process.stdin.isTTY || !process.stdout.isTTY) return null;
  const choices = candidates.filter((candidate) => candidate.hasProfile);
  const lines = [
    "[pbc] No persistent profile exists at the default Codex profile path:",
    `      ${USER_DATA_DIR}`,
    "[pbc] Choose a Chrome profile to clone, or create an empty profile:",
    ...choices.map((candidate, index) => `  ${index + 1}. ${candidate.label} (${candidate.userDataDir})`),
    `  ${choices.length + 1}. Empty new profile`,
    "",
  ];
  console.log(lines.join("\n"));

  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  try {
    const answer = await rl.question(`Select 1-${choices.length + 1}: `);
    const index = Number(answer);
    if (!Number.isInteger(index) || index < 1 || index > choices.length + 1) {
      throw new Error("Invalid profile selection.");
    }
    if (index === choices.length + 1) return { mode: "empty" };
    return { mode: "clone", ...choices[index - 1] };
  } finally {
    rl.close();
  }
}

function chromeProcessRunning() {
  const result = spawnSync("tasklist.exe", ["/FI", "IMAGENAME eq chrome.exe"], {
    encoding: "utf8",
    windowsHide: true,
  });
  if ((result.status ?? 1) !== 0) return false;
  return /chrome\.exe/i.test(String(result.stdout || ""));
}

function shouldCopyProfileEntry(source) {
  const name = path.basename(source).toLowerCase();
  if (name.startsWith("singleton")) return false;
  if (["crashpad", "shadercache", "grshadercache", "pnacltranslationcache", "swreporter"].includes(name)) return false;
  return true;
}

async function ensureDefaultProfile(argv) {
  if (fs.existsSync(USER_DATA_DIR)) return;

  if (!USER_DATA_DIR_IS_DEFAULT) {
    fs.mkdirSync(USER_DATA_DIR, { recursive: true });
    return;
  }

  if (hasFlag("--no-profile-clone", argv)) {
    fs.mkdirSync(USER_DATA_DIR, { recursive: true });
    console.log(`[pbc] Created empty persistent profile: ${USER_DATA_DIR}`);
    return;
  }

  const explicitSource = readArg("--profile-source", argv);
  let source = explicitSource ? resolveProfileSource(explicitSource) : null;
  if (!source) source = await promptProfileSource(chromeChannels());

  if (!source) {
    const available = chromeChannels()
      .filter((channel) => channel.hasProfile)
      .map((channel) => `${channel.id}=${channel.userDataDir}`)
      .join("; ");
    throw new Error(
      [
        `Persistent profile is missing: ${USER_DATA_DIR}`,
        "Run again with --profile-source stable|beta|dev|canary|empty|<path>, or run from an interactive terminal to choose.",
        available ? `Detected profiles: ${available}` : "No existing Chrome user-data directories were detected.",
      ].join("\n")
    );
  }

  if (source.mode === "empty") {
    fs.mkdirSync(USER_DATA_DIR, { recursive: true });
    console.log(`[pbc] Created empty persistent profile: ${USER_DATA_DIR}`);
    return;
  }

  if (!source.hasProfile || !fs.existsSync(source.userDataDir)) {
    throw new Error(`Chrome profile source not found: ${source.userDataDir}`);
  }

  if (chromeProcessRunning()) {
    throw new Error(`Close Chrome before cloning a profile from ${source.userDataDir}`);
  }

  fs.mkdirSync(path.dirname(USER_DATA_DIR), { recursive: true });
  console.log(`[pbc] Cloning ${source.label} profile into ${USER_DATA_DIR}`);
  fs.cpSync(source.userDataDir, USER_DATA_DIR, {
    recursive: true,
    filter: shouldCopyProfileEntry,
  });
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

function traceRoot() {
  return path.join(ROOT, "output", "pbc-traces");
}

function safeName(value) {
  return String(value || "trace")
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 80) || "trace";
}

function makeTraceDir(commandName, argv) {
  const explicit = readArg("--trace-dir", argv);
  if (explicit) {
    const dir = path.resolve(explicit);
    fs.mkdirSync(dir, { recursive: true });
    return dir;
  }

  fs.mkdirSync(traceRoot(), { recursive: true });
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  const base = path.join(traceRoot(), `${stamp}-${safeName(commandName)}`);
  let dir = base;
  let suffix = 1;
  while (fs.existsSync(dir)) {
    dir = `${base}-${suffix}`;
    suffix += 1;
  }
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

function errorInfo(error) {
  if (!error) return null;
  return {
    name: error.name || "Error",
    message: error.message || String(error),
    stack: error.stack || "",
  };
}

async function captureTraceState(port, token, frame, dir, phase, options = {}) {
  const state = { phase, capturedAt: new Date().toISOString(), errors: [] };
  const screenshotPath = path.join(dir, `${phase}.png`);
  const includeSnapshot = options.includeSnapshot !== false;

  try {
    const screenshot = await screenshotTab(port, token, screenshotPath, { fullPage: true });
    state.screenshot = screenshot.path;
    state.url = screenshot.url;
  } catch (error) {
    state.errors.push({ step: "screenshot", ...errorInfo(error) });
  }

  if (includeSnapshot) {
    try {
      const snapshot = await snapshotTab(port, token, { frame });
      state.snapshot = snapshot;
      fs.writeFileSync(path.join(dir, `${phase}-snapshot.json`), JSON.stringify(snapshot, null, 2));
    } catch (error) {
      state.errors.push({ step: "snapshot", ...errorInfo(error) });
    }
  }

  try {
    const text = await textTab(port, token, { frame });
    state.text = { tab: text.tab, frame: text.frame, length: text.text.length };
    fs.writeFileSync(path.join(dir, `${phase}-text.txt`), text.text);
  } catch (error) {
    state.errors.push({ step: "text", ...errorInfo(error) });
  }

  return state;
}

async function runWithTrace(options, action) {
  const { enabled, port, token, frame, commandName, argv } = options;
  if (!enabled) return await action();

  const dir = makeTraceDir(commandName, argv);
  const trace = {
    command: commandName,
    argv,
    port,
    token,
    frame: frame || null,
    startedAt: new Date().toISOString(),
    traceDir: dir,
    before: null,
    after: null,
    result: null,
    error: null,
  };

  try {
    trace.before = await captureTraceState(port, token, frame, dir, "before", { includeSnapshot: false });
    const result = await action();
    trace.result = result;
    trace.after = await captureTraceState(port, token, frame, dir, "after");
    return result;
  } catch (error) {
    trace.error = errorInfo(error);
    trace.after = await captureTraceState(port, token, frame, dir, "after-error");
    throw error;
  } finally {
    trace.finishedAt = new Date().toISOString();
    fs.writeFileSync(path.join(dir, "trace.json"), JSON.stringify(trace, null, 2));
    console.log(`[pbc] Trace saved: ${dir}`);
  }
}

function listTraceDirs() {
  if (!fs.existsSync(traceRoot())) return [];
  return fs.readdirSync(traceRoot(), { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => {
      const fullPath = path.join(traceRoot(), entry.name);
      const stat = fs.statSync(fullPath);
      return { name: entry.name, path: fullPath, mtimeMs: stat.mtimeMs };
    })
    .sort((a, b) => b.mtimeMs - a.mtimeMs);
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
    await ensureDefaultProfile(argv);
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

  if (cmd === "trace") {
    const sub = argv[1] || "list";
    const traces = listTraceDirs();

    if (sub === "list") {
      if (!traces.length) {
        console.log("[pbc] No traces found.");
        process.exit(0);
      }
      for (const trace of traces.slice(0, 20)) {
        console.log(`${trace.name} | ${trace.path}`);
      }
      process.exit(0);
    }

    if (sub === "latest") {
      const latest = traces[0];
      if (!latest) {
        console.log("[pbc] No traces found.");
        process.exit(1);
      }
      console.log(latest.path);
      process.exit(0);
    }

    console.log("Usage: pbc trace list | latest");
    process.exit(1);
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
        console.log("Usage: pbc tab goto <id|match|active> <url> [--trace] [--trace-dir <path>] [--port 9222]");
        process.exit(1);
      }
      const result = await runWithTrace({
        enabled: hasFlag("--trace", argv),
        port,
        token,
        frame: null,
        commandName: "tab-goto",
        argv,
      }, () => gotoTab(port, token, url));
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
        console.log("Usage: pbc tab snapshot <id|match|active> [--frame <name-or-url>] [--json] [--trace] [--trace-dir <path>] [--port 9222]");
        process.exit(1);
      }
      const info = await runWithTrace({
        enabled: hasFlag("--trace", argv),
        port,
        token,
        frame,
        commandName: "tab-snapshot",
        argv,
      }, () => snapshotTab(port, token, { frame }));
      if (hasFlag("--json", argv)) printJson(info);
      else renderSnapshot(info);
      process.exit(0);
    }

    if (sub === "text") {
      const args = positionalArgs(argv.slice(2));
      const token = args[0];
      const frame = readArg("--frame", argv);
      if (!token || token.startsWith("-")) {
        console.log("Usage: pbc tab text <id|match|active> [--frame <name-or-url>] [--json] [--trace] [--trace-dir <path>] [--port 9222]");
        process.exit(1);
      }
      const info = await runWithTrace({
        enabled: hasFlag("--trace", argv),
        port,
        token,
        frame,
        commandName: "tab-text",
        argv,
      }, () => textTab(port, token, { frame }));
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
        console.log("Usage: pbc tab click <id|match|active> <ref|selector|text> [--frame <name-or-url>] [--trace] [--trace-dir <path>] [--port 9222]");
        process.exit(1);
      }
      const result = await runWithTrace({
        enabled: hasFlag("--trace", argv),
        port,
        token,
        frame,
        commandName: "tab-click",
        argv,
      }, () => clickTab(port, token, target, { frame }));
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
        console.log("Usage: pbc tab fill <id|match|active> <ref|selector|label> <value> [--frame <name-or-url>] [--trace] [--trace-dir <path>] [--port 9222]");
        process.exit(1);
      }
      const result = await runWithTrace({
        enabled: hasFlag("--trace", argv),
        port,
        token,
        frame,
        commandName: "tab-fill",
        argv,
      }, () => fillTab(port, token, target, value, { frame }));
      console.log(`[pbc] Filled ${result.mode} ${JSON.stringify(result.filled)} using ${result.method}.`);
      process.exit(0);
    }

    if (sub === "screenshot") {
      const args = positionalArgs(argv.slice(2));
      const token = args[0];
      const outputPath = path.resolve(args[1] || defaultScreenshotPath());
      if (!token || token.startsWith("-")) {
        console.log("Usage: pbc tab screenshot <id|match|active> [path] [--full-page] [--trace] [--trace-dir <path>] [--port 9222]");
        process.exit(1);
      }
      fs.mkdirSync(path.dirname(outputPath), { recursive: true });
      const result = await runWithTrace({
        enabled: hasFlag("--trace", argv),
        port,
        token,
        frame: null,
        commandName: "tab-screenshot",
        argv,
      }, () => screenshotTab(port, token, outputPath, { fullPage: hasFlag("--full-page", argv) }));
      console.log(`[pbc] Screenshot saved: ${result.path}`);
      process.exit(0);
    }

    if (sub === "eval") {
      const args = positionalArgs(argv.slice(2));
      const token = args[0];
      const source = args.slice(1).join(" ");
      const frame = readArg("--frame", argv);
      if (!token || !source) {
        console.log("Usage: pbc tab eval <id|match|active> <javascript> [--frame <name-or-url>] [--json] [--trace] [--trace-dir <path>] [--port 9222]");
        process.exit(1);
      }
      const result = await runWithTrace({
        enabled: hasFlag("--trace", argv),
        port,
        token,
        frame,
        commandName: "tab-eval",
        argv,
      }, () => evalTab(port, token, source, { frame }));
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
