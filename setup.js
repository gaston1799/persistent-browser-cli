const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const https = require("node:https");
const { spawnSync } = require("node:child_process");

const ROOT = __dirname;
const VERSION = process.env.PBC_VERSION || "0.0.0";
const DEFAULT_REPO_URL = "https://github.com/gaston1799/persistent-browser-cli.git";

function help(exitCode = 0) {
  console.log(`
persistent-browser-cli setup

Usage:
  setup.exe [--repo-url <url>] [--install-root <path>] [--link-global] [--clone-stable-chrome-profile]

Options:
  --repo-url <url>                  Repository to clone. Defaults to ${DEFAULT_REPO_URL}
  --install-root <path>             User-local install root. Defaults to %LOCALAPPDATA%\\persistent-browser-cli
  --link-global                     Create PATH shims via npm link after install
  --clone-stable-chrome-profile     Copy the stable Chrome profile if Chrome is not running
  -h, --help                        Show this help
`.trim());
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

function run(command, args, options = {}) {
  const result = spawnSync(command, args, {
    cwd: options.cwd || ROOT,
    stdio: options.stdio || "inherit",
    windowsHide: true,
    shell: false,
    env: options.env || process.env,
  });
  if (result.error) throw result.error;
  return result.status ?? 1;
}

function requestJson(url) {
  return new Promise((resolve, reject) => {
    const req = https.request(url, {
      headers: {
        "User-Agent": "persistent-browser-cli-setup",
        Accept: "application/json",
      },
    }, (res) => {
      const chunks = [];
      res.on("data", (chunk) => chunks.push(chunk));
      res.on("end", () => {
        const body = Buffer.concat(chunks).toString("utf8");
        if (res.statusCode && res.statusCode >= 400) {
          reject(new Error(`HTTP ${res.statusCode}: ${body.slice(0, 300)}`));
          return;
        }
        try {
          resolve(JSON.parse(body));
        } catch (error) {
          reject(error);
        }
      });
    });
    req.on("error", reject);
    req.end();
  });
}

function requestBuffer(url) {
  return new Promise((resolve, reject) => {
    const req = https.request(url, {
      headers: {
        "User-Agent": "persistent-browser-cli-setup",
        Accept: "application/octet-stream",
      },
    }, (res) => {
      const chunks = [];
      res.on("data", (chunk) => chunks.push(chunk));
      res.on("end", () => {
        if (res.statusCode && res.statusCode >= 400) {
          reject(new Error(`HTTP ${res.statusCode}`));
          return;
        }
        resolve(Buffer.concat(chunks));
      });
    });
    req.on("error", reject);
    req.end();
  });
}

function isNodeReady() {
  return run("node", ["--version"], { stdio: "ignore" }) === 0 && run("npm", ["--version"], { stdio: "ignore" }) === 0;
}

function userInstallRoot(argv) {
  return readArg("--install-root", argv) || path.join(os.homedir(), "AppData", "Local", "persistent-browser-cli");
}

async function latestNodeLts() {
  const releases = await requestJson("https://nodejs.org/dist/index.json");
  const stable = releases.find((release) => release.lts);
  if (!stable) throw new Error("Could not determine the latest Node.js LTS release.");
  const version = String(stable.version || "").replace(/^v/i, "");
  return {
    version,
    filename: `node-v${version}-win-x64.zip`,
    downloadUrl: `https://nodejs.org/dist/v${version}/node-v${version}-win-x64.zip`,
  };
}

function refreshUserPath(additionalPath) {
  const machine = spawnSync("powershell", [
    "-NoProfile",
    "-Command",
    "[Environment]::GetEnvironmentVariable('Path', 'Machine')",
  ], { encoding: "utf8", windowsHide: true });
  const user = spawnSync("powershell", [
    "-NoProfile",
    "-Command",
    "[Environment]::GetEnvironmentVariable('Path', 'User')",
  ], { encoding: "utf8", windowsHide: true });
  const machinePath = String(machine.stdout || "").trim();
  const userPath = String(user.stdout || "").trim();
  const parts = [];
  if (additionalPath) parts.push(additionalPath);
  if (userPath) parts.push(userPath);
  if (machinePath) parts.push(machinePath);
  process.env.PATH = parts.join(path.delimiter);
}

function ensureUserPathContains(entry) {
  const current = String(process.env.Path || process.env.PATH || "");
  const segments = current.split(path.delimiter).map((part) => part.trim()).filter(Boolean);
  if (segments.some((part) => part.toLowerCase() === entry.toLowerCase())) return;

  const updated = [entry, ...segments].join(path.delimiter);
  const ps = `[Environment]::SetEnvironmentVariable('Path', ${JSON.stringify(updated)}, 'User')`;
  const status = run("powershell", ["-NoProfile", "-ExecutionPolicy", "Bypass", "-Command", ps], { stdio: "ignore" });
  if (status !== 0) {
    throw new Error("Failed to update the user PATH.");
  }
}

async function installNodeIfNeeded(installRoot) {
  if (isNodeReady()) return;

  const nodeRoot = path.join(installRoot, "tools", "nodejs");
  const nodeExe = path.join(nodeRoot, "node.exe");
  const npmCmd = path.join(nodeRoot, "npm.cmd");
  if (!fs.existsSync(nodeExe) || !fs.existsSync(npmCmd)) {
    const latest = await latestNodeLts();
    console.log(`[setup] Downloading Node.js ${latest.version} ...`);
    const zipPath = path.join(os.tmpdir(), latest.filename);
    fs.writeFileSync(zipPath, await requestBuffer(latest.downloadUrl));

    fs.mkdirSync(nodeRoot, { recursive: true });
    const expand = [
      "-NoProfile",
      "-ExecutionPolicy",
      "Bypass",
      "-Command",
      `Expand-Archive -LiteralPath ${JSON.stringify(zipPath)} -DestinationPath ${JSON.stringify(nodeRoot)} -Force`,
    ];
    const status = run("powershell", expand, { stdio: "inherit" });
    if (status !== 0) {
      throw new Error("Failed to extract Node.js.");
    }

    const extractedDir = path.join(nodeRoot, `node-v${latest.version}-win-x64`);
    if (fs.existsSync(extractedDir)) {
      for (const entry of fs.readdirSync(extractedDir)) {
        const source = path.join(extractedDir, entry);
        const target = path.join(nodeRoot, entry);
        if (fs.existsSync(target)) {
          continue;
        }
        fs.cpSync(source, target, { recursive: true });
      }
    }
  }

  ensureUserPathContains(nodeRoot);
  refreshUserPath(nodeRoot);

  if (!isNodeReady()) {
    throw new Error("Node.js installation completed, but node/npm are still not visible in this session.");
  }
}

async function main() {
  const argv = process.argv.slice(2);
  if (argv.length === 0 || hasFlag("-h", argv) || hasFlag("--help", argv)) {
    help(0);
  }

  const repoUrl = readArg("--repo-url", argv) || DEFAULT_REPO_URL;
  const installRoot = userInstallRoot(argv);
  const linkGlobal = hasFlag("--link-global", argv);
  const cloneStableChromeProfile = hasFlag("--clone-stable-chrome-profile", argv);

  fs.mkdirSync(installRoot, { recursive: true });

  console.log(`[setup] Version: v${VERSION}`);
  console.log(`[setup] Install root: ${installRoot}`);

  await installNodeIfNeeded(installRoot);
  console.log("[setup] Node.js and npm are available.");

  const repoDir = path.join(installRoot, "persistent-browser-cli");
  const gitExists = run("git", ["--version"], { stdio: "ignore" }) === 0;
  if (!gitExists) {
    throw new Error("git is required for the bootstrapper.");
  }

  if (!fs.existsSync(repoDir)) {
    console.log(`[setup] Cloning repo into ${repoDir}`);
    run("git", ["clone", repoUrl, repoDir]);
  } else {
    console.log(`[setup] Repo already exists at ${repoDir}`);
  }

  const installPs1 = path.join(ROOT, "install.ps1");
  if (!fs.existsSync(installPs1)) {
    throw new Error("Embedded install.ps1 asset was not found.");
  }

  const installArgs = [
    "-NoProfile",
    "-ExecutionPolicy",
    "Bypass",
    "-File",
    installPs1,
    "-RepoUrl",
    repoUrl,
    "-InstallRoot",
    installRoot,
  ];
  if (linkGlobal) installArgs.push("-LinkGlobal");
  if (cloneStableChromeProfile) installArgs.push("-CloneStableChromeProfile");

  const status = run("powershell", installArgs, { cwd: repoDir });
  if (status !== 0) {
    process.exit(status);
  }

  console.log("[setup] Bootstrap complete.");
}

main().catch((error) => {
  console.error("[setup] failed");
  console.error(error && error.stack ? error.stack : error);
  process.exit(1);
});
