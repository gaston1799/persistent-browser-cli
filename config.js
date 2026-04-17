const os = require("node:os");
const path = require("node:path");

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
  path.join(process.env.LOCALAPPDATA || path.join(os.homedir(), "AppData", "Local"), "persistent-browser-cli");

module.exports = {
  CHROME_EXE: resolveChromeExe(),
  USER_DATA_DIR: process.env.PBC_USER_DATA_DIR || path.join(DATA_ROOT, "profiles", "default"),
  BACKUP_ROOT: process.env.PBC_BACKUP_ROOT || path.join(DATA_ROOT, "backups"),
  DEFAULT_CDP_PORT: envInt("PBC_CDP_PORT", 9222),
  DEFAULT_PWCLI_SESSION: process.env.PBC_PWCLI_SESSION || "persistent-browser-cli",
};
