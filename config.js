const os = require("node:os");
const path = require("node:path");
const fs = require("node:fs");

function envInt(name, fallback) {
  const raw = process.env[name];
  if (!raw) return fallback;
  const value = Number(raw);
  return Number.isFinite(value) ? value : fallback;
}

function resolveChromeExe() {
  if (process.env.PBC_CHROME_EXE) return process.env.PBC_CHROME_EXE;

  const candidates = [
    path.join(process.env.PROGRAMFILES || "C:\\Program Files", "Google", "Chrome", "Application", "chrome.exe"),
    path.join(process.env["PROGRAMFILES(X86)"] || "C:\\Program Files (x86)", "Google", "Chrome", "Application", "chrome.exe"),
    path.join(process.env.LOCALAPPDATA || path.join(os.homedir(), "AppData", "Local"), "Google", "Chrome", "Application", "chrome.exe"),
  ];

  return candidates[0];
}

const DATA_ROOT =
  process.env.PBC_DATA_ROOT ||
  path.join(os.homedir(), ".codex", "pbcDataDir");

function loadLocalOverrides() {
  const localPath = path.join(__dirname, "config.local.json");
  if (!fs.existsSync(localPath)) return {};

  try {
    return JSON.parse(fs.readFileSync(localPath, "utf8"));
  } catch (error) {
    throw new Error(`Failed to parse ${localPath}: ${error.message}`);
  }
}

const local = loadLocalOverrides();

module.exports = {
  CHROME_EXE: process.env.PBC_CHROME_EXE || local.CHROME_EXE || resolveChromeExe(),
  USER_DATA_DIR: process.env.PBC_USER_DATA_DIR || local.USER_DATA_DIR || path.join(DATA_ROOT, "profiles", "default"),
  USER_DATA_DIR_IS_DEFAULT: !process.env.PBC_USER_DATA_DIR && !local.USER_DATA_DIR,
  DATA_ROOT,
  BACKUP_ROOT: process.env.PBC_BACKUP_ROOT || local.BACKUP_ROOT || path.join(DATA_ROOT, "backups"),
  DEFAULT_CDP_PORT: envInt("PBC_CDP_PORT", local.DEFAULT_CDP_PORT || 9222),
  DEFAULT_PWCLI_SESSION: process.env.PBC_PWCLI_SESSION || local.DEFAULT_PWCLI_SESSION || "persistent-browser-cli",
};
