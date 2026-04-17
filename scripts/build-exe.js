const fs = require("node:fs");
const path = require("node:path");
const { spawnSync } = require("node:child_process");
const esbuild = require("esbuild");

const SENTINEL_FUSE = "NODE_SEA_FUSE_fce680ab2cc467b6e072b8b5df1996b2";

function run(command, args, options = {}) {
  const result = spawnSync(command, args, {
    stdio: "inherit",
    ...options,
  });
  if ((result.status ?? 1) !== 0) {
    process.exit(result.status ?? 1);
  }
}

function runAllowWarning(command, args, options = {}) {
  const result = spawnSync(command, args, {
    encoding: "utf8",
    ...options,
  });
  if (result.stdout) process.stdout.write(result.stdout);
  if (result.stderr) process.stderr.write(result.stderr);
  if ((result.status ?? 1) === 0) return;

  const combined = `${result.stdout || ""}\n${result.stderr || ""}`;
  if (combined.includes("warning: The signature seems corrupted!")) {
    return;
  }
  process.exit(result.status ?? 1);
}

async function main() {
  const root = path.resolve(__dirname, "..");
  const buildDir = path.join(root, "build");
  const distDir = path.join(root, "dist");
  const bundlePath = path.join(buildDir, "sea-entry.cjs");
  const configPath = path.join(buildDir, "sea-config.json");
  const blobPath = path.join(buildDir, "sea-prep.blob");
  const outputExe = path.join(distDir, "pbc.exe");

  fs.mkdirSync(buildDir, { recursive: true });
  fs.mkdirSync(distDir, { recursive: true });

  await esbuild.build({
    entryPoints: [path.join(root, "cli.js")],
    outfile: bundlePath,
    bundle: true,
    external: ["playwright-core"],
    platform: "node",
    format: "cjs",
    target: ["node23"],
    legalComments: "none",
    banner: {
      js: "const { createRequire } = require('node:module');\nrequire = createRequire(__filename);",
    },
  });

  const seaConfig = {
    main: bundlePath,
    output: blobPath,
    mainFormat: "commonjs",
    disableExperimentalSEAWarning: true,
    useSnapshot: false,
    useCodeCache: false,
    execArgvExtension: "none",
    assets: {
      "open_persistent_chrome.ps1": path.join(root, "open_persistent_chrome.ps1"),
      "backup_profile.ps1": path.join(root, "backup_profile.ps1"),
    },
  };

  fs.writeFileSync(configPath, `${JSON.stringify(seaConfig, null, 2)}\n`);
  if (fs.existsSync(blobPath)) fs.rmSync(blobPath, { force: true });
  if (fs.existsSync(outputExe)) fs.rmSync(outputExe, { force: true });

  run(process.execPath, ["--experimental-sea-config", configPath], { cwd: root });
  fs.copyFileSync(process.execPath, outputExe);

  const postjectCli = path.join(root, "node_modules", "postject", "dist", "cli.js");
  runAllowWarning(process.execPath, [postjectCli, outputExe, "NODE_SEA_BLOB", blobPath, "--sentinel-fuse", SENTINEL_FUSE], {
    cwd: root,
  });

  if (!fs.existsSync(outputExe)) {
    console.error(`[pbc] SEA build completed without producing ${outputExe}`);
    process.exit(1);
  }

  console.log(`[pbc] Built ${outputExe}`);
}

main().catch((error) => {
  console.error("[pbc] build:exe failed");
  console.error(error && error.stack ? error.stack : error);
  process.exit(1);
});
