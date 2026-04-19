const fs = require("node:fs");
const path = require("node:path");
const https = require("node:https");
const { spawnSync } = require("node:child_process");

function readJson(filePath) {
  return JSON.parse(fs.readFileSync(filePath, "utf8"));
}

function semverParts(version) {
  return String(version || "")
    .replace(/^v/i, "")
    .split(".")
    .map((part) => Number.parseInt(part, 10) || 0);
}

function compareSemver(a, b) {
  const left = semverParts(a);
  const right = semverParts(b);
  const length = Math.max(left.length, right.length);
  for (let i = 0; i < length; i += 1) {
    const delta = (left[i] || 0) - (right[i] || 0);
    if (delta !== 0) return delta;
  }
  return 0;
}

function requestJson(url, headers = {}) {
  return new Promise((resolve, reject) => {
    const req = https.request(
      url,
      {
        headers: {
          "User-Agent": "persistent-browser-cli",
          Accept: "application/vnd.github+json",
          ...headers,
        },
      },
      (res) => {
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
      }
    );
    req.on("error", reject);
    req.end();
  });
}

function requestBuffer(url) {
  return new Promise((resolve, reject) => {
    const req = https.request(
      url,
      {
        headers: {
          "User-Agent": "persistent-browser-cli",
          Accept: "application/octet-stream",
        },
      },
      (res) => {
        const chunks = [];
        res.on("data", (chunk) => chunks.push(chunk));
        res.on("end", () => {
          if (res.statusCode && res.statusCode >= 400) {
            reject(new Error(`HTTP ${res.statusCode}`));
            return;
          }
          resolve(Buffer.concat(chunks));
        });
      }
    );
    req.on("error", reject);
    req.end();
  });
}

function run(command, args, options = {}) {
  const result = spawnSync(command, args, {
    cwd: options.cwd || process.cwd(),
    stdio: options.stdio || "inherit",
    windowsHide: true,
    shell: false,
  });
  if (result.error) throw result.error;
  return result.status ?? 1;
}

async function getLatestRelease(repoFullName) {
  return requestJson(`https://api.github.com/repos/${repoFullName}/releases/latest`);
}

async function checkForUpdate({ repoFullName, currentVersion }) {
  const latest = await getLatestRelease(repoFullName);
  const latestVersion = String(latest.tag_name || "").replace(/^v/i, "");
  return {
    currentVersion,
    latestVersion,
    latestTag: latest.tag_name || "",
    releaseUrl: latest.html_url || "",
    assetNames: (latest.assets || []).map((asset) => asset.name),
    updateAvailable: compareSemver(latestVersion, currentVersion) > 0,
    release: latest,
  };
}

async function installRepo({ repoDir }) {
  const gitExists = spawnSync("git", ["--version"], { stdio: "ignore", windowsHide: true }).status === 0;
  if (!gitExists) {
    throw new Error("git is required for self-update in this install mode.");
  }

  if (!fs.existsSync(path.join(repoDir, ".git"))) {
    throw new Error("This install does not appear to be a git checkout. Re-run the installer in a cloned repo.");
  }

  const fetchStatus = run("git", ["fetch", "--tags", "--prune"], { cwd: repoDir });
  if (fetchStatus !== 0) return fetchStatus;

  const pullStatus = run("git", ["pull", "--ff-only"], { cwd: repoDir });
  if (pullStatus !== 0) return pullStatus;

  const npmInstallStatus = run("npm", ["install"], { cwd: repoDir });
  return npmInstallStatus;
}

module.exports = {
  checkForUpdate,
  compareSemver,
  installRepo,
  requestBuffer,
  requestJson,
  run,
};
