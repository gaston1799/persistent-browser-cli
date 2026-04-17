#!/usr/bin/env node
/* eslint-disable no-console */

const fs = require("node:fs");
const http = require("node:http");
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
  activateTab,
  closeTab,
  gotoTab,
  inspectFields,
  listFrames,
  listTabs,
  pruneDuplicateTabs,
  saveAndCloseBrowser,
  reuseOrOpenTab,
} = require("./tab_tools");

const ROOT = __dirname;

function usage(exitCode = 0) {
  const txt = `
persistent-browser-cli

Usage:
  pbc open [url] [--port 9222] [--reuse] [--match "<text>"] [--tab <id>]
  pbc cdp [--port 9222]
  pbc saveandclose [--port 9222]
  pbc sac [--port 9222]
  pbc backup [--kill]

  pbc tab list [--port 9222]
  pbc tab activate <id|match> [--port 9222]
  pbc tab goto <id|match|active> <url> [--port 9222]
  pbc tab close <id|match> [--port 9222]
  pbc tab frames <id|match|active> [--port 9222]
  pbc tab inspect <id|match|active> [--frame <name-or-url>] [--port 9222]
  pbc tab prune [--port 9222] [--keep <id|match>]

  pbc pw <playwright-cli args...>

Environment overrides:
  PBC_CHROME_EXE
  PBC_USER_DATA_DIR
  PBC_BACKUP_ROOT
  PBC_CDP_PORT
  PBC_PWCLI_SESSION

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

function runPwsh(ps1, args = []) {
  const script = path.join(ROOT, ps1);
  const result = spawnSync(
    "powershell",
    ["-NoProfile", "-ExecutionPolicy", "Bypass", "-File", script, ...args],
    { stdio: "inherit", cwd: ROOT }
  );
  process.exit(result.status ?? 1);
}

function runPlaywrightCli(args) {
  const localPwCli = path.join(ROOT, "node_modules", "@playwright", "cli", "playwright-cli.js");
  const hasLocal = fs.existsSync(localPwCli);
  const hasSession = args.some((a) => a === "--session" || String(a).startsWith("--session=") || a === "-s" || String(a).startsWith("-s="));
  const effectiveArgs = hasSession ? args : ["--session", DEFAULT_PWCLI_SESSION, ...args];

  const sub = args[0];
  if (sub === "open") {
    const hasBrowser = args.some((a) => a === "--browser" || String(a).startsWith("--browser="));
    const hasHeaded = args.includes("--headed");
    const hasPersistent = args.includes("--persistent");
    const hasProfile = args.some((a) => a === "--profile" || String(a).startsWith("--profile="));
    if (!hasBrowser) args = [...args, "--browser", "chrome"];
    if (!hasHeaded) args = [...args, "--headed"];
    if (!hasPersistent) args = [...args, "--persistent"];
    if (!hasProfile) args = [...args, "--profile", USER_DATA_DIR];
  }

  const runArgs = hasSession ? args : ["--session", DEFAULT_PWCLI_SESSION, ...args];
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

async function main() {
  const argv = process.argv.slice(2);
  if (argv.length === 0) usage(0);
  if (argv[0] === "-h" || argv[0] === "--help") usage(0);

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

    runPwsh("open_persistent_chrome.ps1", [
      "-Url",
      url,
      "-RemoteDebuggingPort",
      String(port),
      "-ChromeExe",
      CHROME_EXE,
      "-UserDataDir",
      USER_DATA_DIR,
    ]);
    return;
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

  if (cmd === "saveandclose" || cmd === "sac") {
    const port = Number(readArg("--port", argv) || DEFAULT_CDP_PORT);
    const up = await isCdpUp(port);
    if (!up) {
      console.log(`CDP: DOWN (http://127.0.0.1:${port})`);
      process.exit(2);
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
        process.exit(0);
      }
      await new Promise((resolve) => setTimeout(resolve, 250));
    }

    console.log("[pbc] Browser.close was requested, but CDP still appears up. You may need to close Chrome manually.");
    process.exit(1);
  }

  if (cmd === "backup") {
    const kill = hasFlag("--kill", argv);
    runPwsh("backup_profile.ps1", [
      "-SourceDir",
      USER_DATA_DIR,
      "-BackupRoot",
      BACKUP_ROOT,
      ...(kill ? ["-KillChrome"] : []),
    ]);
    return;
  }

  if (cmd === "tab") {
    const sub = argv[1];
    const port = Number(readArg("--port", argv) || DEFAULT_CDP_PORT);
    if (!(await isCdpUp(port))) {
      console.log(`CDP: DOWN (http://127.0.0.1:${port})`);
      process.exit(2);
    }

    if (sub === "list") {
      const tabs = await listTabs(port);
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
        console.log(`${frame.isMain ? "*" : " "} [${frame.index}] ${frame.name || "(no name)"} | ${frame.url}`);
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

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
