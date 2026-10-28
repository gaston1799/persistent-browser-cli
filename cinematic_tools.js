const fs = require("node:fs");
const path = require("node:path");
const { spawnSync } = require("node:child_process");
const { chromium } = require("playwright-core");

const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function safeName(value) {
  return String(value || "cinematic")
    .trim()
    .replace(/[^a-z0-9._-]+/gi, "-")
    .replace(/^-+|-+$/g, "") || "cinematic";
}

function ffmpegAvailable() {
  const result = spawnSync("ffmpeg", ["-version"], { windowsHide: true, stdio: "ignore" });
  return result.status === 0;
}

async function disconnectBrowser(browser) {
  if (!browser) return;
  // This is a user-owned persistent Chrome instance. A normal browser.close()
  // sends Browser.close and shuts it down, so use Playwright's connection-only
  // close path just like the rest of PBC.
  browser._shouldCloseConnectionOnClose = true;
  browser._connection.once("close", () => {
    setTimeout(() => browser._didClose(), 0);
  });
  await browser.close();
}

function quoteConcatPath(filePath) {
  return path.resolve(filePath).replace(/\\/g, "/").replace(/'/g, "'\\''");
}

function writeJson(filePath, value) {
  fs.writeFileSync(filePath, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}

function readScript(scriptPath) {
  const absolute = path.resolve(scriptPath);
  const parsed = JSON.parse(fs.readFileSync(absolute, "utf8"));
  if (!parsed || !Array.isArray(parsed.scenes) || parsed.scenes.length === 0) {
    throw new Error("A cinematic script needs a non-empty scenes array.");
  }
  return { absolute, script: parsed };
}

async function choosePage(browser, token) {
  const pages = browser.contexts().flatMap((context) => context.pages());
  const usable = pages.filter((page) => {
    const url = page.url();
    return !url.startsWith("chrome://") && !url.startsWith("devtools://") && !url.startsWith("chrome-extension://");
  });
  if (!usable.length) throw new Error("No usable page tab is available over CDP.");
  if (!token || token === "active") {
    for (const page of usable) {
      const visible = await page.evaluate(() => document.visibilityState === "visible").catch(() => false);
      if (visible) return page;
    }
    return usable[usable.length - 1];
  }
  const lowered = String(token).toLowerCase();
  const urlMatch = usable.find((page) => page.url().toLowerCase().includes(lowered));
  if (urlMatch) return urlMatch;
  for (const page of usable) {
    const title = await page.title().catch(() => "");
    if (title.toLowerCase().includes(lowered)) return page;
  }
  return usable[usable.length - 1];
}

async function installCaptureOverlay(page, redactions = []) {
  await page.evaluate((selectors) => {
    if (document.querySelector("#__pbc_cinematic_overlay")) return;
    const host = document.createElement("div");
    host.id = "__pbc_cinematic_overlay";
    host.setAttribute("aria-hidden", "true");
    Object.assign(host.style, {
      position: "fixed",
      inset: "0",
      zIndex: "2147483647",
      pointerEvents: "none",
    });
    const cursor = document.createElement("div");
    cursor.dataset.pbcCursor = "true";
    Object.assign(cursor.style, {
      position: "absolute",
      width: "25px",
      height: "32px",
      backgroundImage: `url("data:image/svg+xml,${encodeURIComponent('<svg xmlns="http://www.w3.org/2000/svg" width="25" height="32" viewBox="0 0 25 32"><path d="M2 1.5v24.2l6.2-6 4.4 10.1 4.7-2.1-4.4-9.7h8.6z" fill="white" stroke="black" stroke-width="2.4" stroke-linejoin="round"/></svg>')}")`,
      backgroundRepeat: "no-repeat",
      backgroundSize: "contain",
      filter: "drop-shadow(0 2px 2px rgba(0,0,0,.45))",
      opacity: "0",
      transition: "left 420ms cubic-bezier(.2,.8,.2,1), top 420ms cubic-bezier(.2,.8,.2,1)",
    });
    const badge = document.createElement("div");
    badge.textContent = "REC";
    Object.assign(badge.style, {
      position: "absolute",
      top: "14px",
      right: "16px",
      padding: "5px 9px",
      borderRadius: "999px",
      color: "white",
      background: "rgba(159,18,57,.8)",
      font: "700 11px/1 system-ui, sans-serif",
      letterSpacing: ".12em",
      opacity: ".72",
    });
    host.append(cursor, badge);
    document.documentElement.append(host);
    for (const selector of selectors) {
      for (const element of document.querySelectorAll(selector)) {
        element.dataset.pbcCinematicFilter = element.style.filter || "";
        element.style.filter = "blur(12px)";
      }
    }
  }, redactions);
}

async function removeCaptureOverlay(page, redactions = []) {
  await page.evaluate((selectors) => {
    document.querySelector("#__pbc_cinematic_overlay")?.remove();
    for (const selector of selectors) {
      for (const element of document.querySelectorAll(selector)) {
        element.style.filter = element.dataset.pbcCinematicFilter || "";
        delete element.dataset.pbcCinematicFilter;
      }
    }
  }, redactions).catch(() => {});
}

async function locatorFor(page, target) {
  if (!target) throw new Error("This scene action requires a target.");
  const selector = page.locator(String(target)).first();
  if (await selector.count().catch(() => 0)) return selector;
  return page.getByText(String(target), { exact: false }).first();
}

async function animateCursor(page, locator, click = false) {
  const box = await locator.boundingBox();
  if (!box) return;
  const x = Math.round(box.x + box.width / 2);
  const y = Math.round(box.y + box.height / 2);
  await page.evaluate(({ x: nextX, y: nextY, click: shouldClick }) => {
    const cursor = document.querySelector("[data-pbc-cursor]");
    if (!cursor) return;
    const initialized = cursor.dataset.initialized === "true";
    if (!initialized) cursor.style.transition = "none";
    cursor.style.left = `${nextX}px`;
    cursor.style.top = `${nextY}px`;
    cursor.style.opacity = "1";
    cursor.dataset.initialized = "true";
    if (!initialized) {
      cursor.getBoundingClientRect();
      cursor.style.transition = "left 420ms cubic-bezier(.2,.8,.2,1), top 420ms cubic-bezier(.2,.8,.2,1)";
    }
    if (shouldClick) {
      const ripple = document.createElement("div");
      Object.assign(ripple.style, {
        position: "absolute",
        left: `${nextX}px`,
        top: `${nextY}px`,
        width: "18px",
        height: "18px",
        border: "2px solid rgba(45,212,191,.95)",
        borderRadius: "50%",
        transform: "translate(-50%, -50%)",
        animation: "pbc-cinematic-ripple 650ms ease-out forwards",
      });
      if (!document.querySelector("#__pbc_cinematic_style")) {
        const style = document.createElement("style");
        style.id = "__pbc_cinematic_style";
        style.textContent = "@keyframes pbc-cinematic-ripple{to{width:58px;height:58px;opacity:0}}";
        document.head.append(style);
      }
      document.querySelector("#__pbc_cinematic_overlay")?.append(ripple);
      setTimeout(() => ripple.remove(), 750);
    }
  }, { x, y, click });
  await wait(480);
}

async function performScene(page, scene, outputDir, index, redactions) {
  const action = scene.action || (scene.goto ? "goto" : scene.click ? "click" : scene.fill ? "fill" : scene.press ? "press" : scene.scroll ? "scroll" : "pause");
  if (scene.pauseBeforeMs) await wait(Number(scene.pauseBeforeMs));
  if (action === "goto") {
    await page.goto(scene.url || scene.goto, { waitUntil: scene.waitUntil || "domcontentloaded" });
    // Navigation replaces the document, including both the recording cursor and
    // redaction styles. Restore them before any post-navigation hold/screenshot.
    await installCaptureOverlay(page, redactions);
  } else if (action === "click") {
    const locator = await locatorFor(page, scene.target || scene.click);
    await locator.scrollIntoViewIfNeeded();
    await animateCursor(page, locator, true);
    await locator.click();
  } else if (action === "fill") {
    const locator = await locatorFor(page, scene.target || scene.fill);
    await locator.scrollIntoViewIfNeeded();
    await animateCursor(page, locator);
    await locator.fill(String(scene.value ?? ""));
  } else if (action === "press") {
    await page.keyboard.press(String(scene.key || scene.press));
  } else if (action === "scroll") {
    const amount = Number(scene.pixels ?? scene.scroll ?? 600);
    await page.evaluate((pixels) => window.scrollBy({ top: pixels, behavior: "smooth" }), amount);
    await wait(Number(scene.scrollDurationMs || 800));
  } else if (action === "pause") {
    await wait(Number(scene.durationMs || scene.pauseMs || 1000));
  } else {
    throw new Error(`Unsupported cinematic action: ${action}`);
  }
  if (scene.waitFor) await page.locator(scene.waitFor).first().waitFor({ state: "visible", timeout: Number(scene.timeoutMs || 15000) });
  if (scene.screenshot) {
    const screenshotName = `${String(index + 1).padStart(2, "0")}-${safeName(scene.title || action)}.png`;
    await page.screenshot({ path: path.join(outputDir, screenshotName), fullPage: Boolean(scene.fullPage) });
  }
  if (scene.pauseAfterMs) await wait(Number(scene.pauseAfterMs));
}

function encodeFrames(frames, outputDir, outputPath, finalHoldSeconds) {
  if (!frames.length) throw new Error("No screencast frames were captured.");
  const concatPath = path.join(outputDir, "frames.ffconcat");
  const lines = ["ffconcat version 1.0"];
  for (let index = 0; index < frames.length; index += 1) {
    const current = frames[index];
    const next = frames[index + 1];
    const duration = next ? Math.max(0.04, Math.min(15, next.time - current.time)) : finalHoldSeconds;
    lines.push(`file '${quoteConcatPath(current.file)}'`);
    lines.push(`duration ${duration.toFixed(3)}`);
  }
  lines.push(`file '${quoteConcatPath(frames[frames.length - 1].file)}'`);
  fs.writeFileSync(concatPath, `${lines.join("\n")}\n`, "utf8");
  const result = spawnSync("ffmpeg", [
    "-y", "-hide_banner", "-loglevel", "error", "-f", "concat", "-safe", "0", "-i", concatPath,
    "-vf", "fps=30,scale=trunc(iw/2)*2:trunc(ih/2)*2,format=yuv420p", "-c:v", "libx264", "-preset", "medium", "-crf", "18",
    "-movflags", "+faststart", outputPath,
  ], { windowsHide: true, encoding: "utf8" });
  if (result.status !== 0) throw new Error(`FFmpeg could not encode the cinematic video: ${result.stderr || result.stdout}`);
  return concatPath;
}

async function runCinematic(options) {
  const { script: spec, absolute: scriptPath } = readScript(options.scriptPath);
  const root = path.resolve(options.outputDir || path.join(process.cwd(), "output", "cinematic", safeName(spec.name)));
  const framesDir = path.join(root, "frames");
  fs.mkdirSync(framesDir, { recursive: true });
  const outputPath = path.resolve(options.outputPath || path.join(root, `${safeName(spec.name)}.mp4`));
  fs.mkdirSync(path.dirname(outputPath), { recursive: true });
  const browser = await chromium.connectOverCDP(`http://127.0.0.1:${options.port}`);
  const page = await choosePage(browser, options.tab || spec.tab || "active");
  const viewport = spec.viewport || {};
  const cdp = await page.context().newCDPSession(page);
  const frames = [];
  const chapters = [];
  const narration = [];
  const startedAt = Date.now();
  let sequence = 0;
  let firstTimestamp = null;
  let stopped = false;
  let sourceUrl = page.url();
  cdp.on("Page.screencastFrame", async (event) => {
    try {
      const stamp = Number(event.metadata?.timestamp || Date.now() / 1000);
      if (firstTimestamp === null) firstTimestamp = stamp;
      const file = path.join(framesDir, `${String(sequence).padStart(6, "0")}.jpg`);
      sequence += 1;
      fs.writeFileSync(file, Buffer.from(event.data, "base64"));
      frames.push({ file, time: stamp - firstTimestamp });
    } finally {
      await cdp.send("Page.screencastFrameAck", { sessionId: event.sessionId }).catch(() => {});
    }
  });
  const redactions = Array.isArray(spec.redact) ? spec.redact : [];
  try {
    await installCaptureOverlay(page, redactions);
    await cdp.send("Page.startScreencast", {
      format: "jpeg",
      quality: Number(spec.quality || 90),
      maxWidth: Number(viewport.width || 1920),
      maxHeight: Number(viewport.height || 1080),
      everyNthFrame: 1,
    });
    for (let index = 0; index < spec.scenes.length; index += 1) {
      const scene = spec.scenes[index];
      // Navigation replaces the document and removes the capture overlay, so
      // restore it before every scene. This is intentionally idempotent.
      await installCaptureOverlay(page, redactions);
      // Long static holds are preserved by the frame encoder, so wall-clock
      // scene starts align with the final encoded timeline.
      const sceneStart = (Date.now() - startedAt) / 1000;
      if (scene.title) chapters.push({ title: scene.title, startSeconds: Number(sceneStart.toFixed(3)) });
      if (scene.narration) narration.push({ title: scene.title || `Scene ${index + 1}`, startSeconds: Number(sceneStart.toFixed(3)), text: scene.narration });
      await performScene(page, scene, root, index, redactions);
    }
    await wait(Number(spec.finalHoldMs || 1200));
    await cdp.send("Page.stopScreencast");
    stopped = true;
    await wait(250);
    sourceUrl = page.url();
    if (!frames.length) {
      const fallback = path.join(framesDir, "000000.jpg");
      await page.screenshot({ path: fallback, type: "jpeg", quality: 90 });
      frames.push({ file: fallback, time: 0 });
    }
  } finally {
    if (!stopped) await cdp.send("Page.stopScreencast").catch(() => {});
    await removeCaptureOverlay(page, redactions);
    await cdp.detach().catch(() => {});
    await disconnectBrowser(browser).catch(() => {});
  }
  const hasFfmpeg = ffmpegAvailable();
  const manifest = {
    schemaVersion: 1,
    name: spec.name || "cinematic",
    sourceScript: scriptPath,
    createdAt: new Date().toISOString(),
    sourceUrl,
    beta: true,
    outputVideo: hasFfmpeg ? outputPath : null,
    durationSeconds: Number(((Date.now() - startedAt) / 1000).toFixed(3)),
    frameCount: frames.length,
    chapters,
    narration,
    voiceover: { status: "pending", recommendedFormat: "wav or mp3" },
  };
  if (hasFfmpeg) encodeFrames(frames, root, outputPath, Number(spec.finalHoldMs || 1200) / 1000);
  writeJson(path.join(root, "manifest.json"), manifest);
  writeJson(path.join(root, "narration.json"), narration);
  fs.writeFileSync(path.join(root, "narration.txt"), narration.map((cue) => cue.text).join("\n\n"), "utf8");
  return { root, outputPath: manifest.outputVideo, manifestPath: path.join(root, "manifest.json"), narrationPath: path.join(root, "narration.txt"), frameCount: frames.length, durationSeconds: manifest.durationSeconds };
}

function stitchVoiceover(videoPath, audioPath, outputPath) {
  if (!ffmpegAvailable()) throw new Error("FFmpeg is required for voiceover stitching but was not found on PATH.");
  const video = path.resolve(videoPath);
  const audio = path.resolve(audioPath);
  const output = path.resolve(outputPath || path.join(path.dirname(video), `${path.basename(video, path.extname(video))}-vo.mp4`));
  if (!fs.existsSync(video)) throw new Error(`Video not found: ${video}`);
  if (!fs.existsSync(audio)) throw new Error(`Voiceover not found: ${audio}`);
  fs.mkdirSync(path.dirname(output), { recursive: true });
  const durationOf = (file) => {
    const probe = spawnSync("ffprobe", [
      "-v", "error", "-show_entries", "format=duration", "-of", "default=noprint_wrappers=1:nokey=1", file,
    ], { windowsHide: true, encoding: "utf8" });
    if (probe.status !== 0) throw new Error(`FFprobe could not read media duration: ${probe.stderr || probe.stdout}`);
    const duration = Number.parseFloat(probe.stdout.trim());
    if (!Number.isFinite(duration)) throw new Error(`FFprobe returned an invalid duration for ${file}.`);
    return duration;
  };
  const videoDuration = durationOf(video);
  const audioDuration = durationOf(audio);
  const padSeconds = Math.max(0, audioDuration - videoDuration + 0.15);
  const videoArgs = padSeconds > 0
    ? ["-vf", `tpad=stop_mode=clone:stop_duration=${padSeconds.toFixed(3)}`, "-c:v", "libx264", "-preset", "medium", "-crf", "18"]
    : ["-c:v", "copy"];
  const result = spawnSync("ffmpeg", [
    "-y", "-hide_banner", "-loglevel", "error", "-i", video, "-i", audio,
    "-map", "0:v:0", "-map", "1:a:0", ...videoArgs, "-af", "apad", "-c:a", "aac", "-b:a", "192k",
    "-shortest", "-movflags", "+faststart", output,
  ], { windowsHide: true, encoding: "utf8" });
  if (result.status !== 0) throw new Error(`FFmpeg could not stitch the voiceover: ${result.stderr || result.stdout}`);
  return { outputPath: output, videoDuration, audioDuration, paddedVideoSeconds: padSeconds };
}

function writeExample(filePath) {
  const output = path.resolve(filePath || "cinematic.example.json");
  const example = {
    name: "product-demo",
    tab: "active",
    viewport: { width: 1920, height: 1080 },
    quality: 90,
    finalHoldMs: 1400,
    redact: ["input[type=password]", "[data-sensitive]"],
    scenes: [
      { title: "Overview", action: "pause", durationMs: 1200, screenshot: true, narration: "See every important signal in one clear dashboard." },
      { title: "Open incidents", action: "click", target: "text=Incidents", pauseAfterMs: 1200, narration: "Move from service health to incident response in one click." },
      { title: "Review the timeline", action: "scroll", pixels: 600, scrollDurationMs: 900, pauseAfterMs: 800, narration: "Review ownership, status, and recent changes without losing context." },
    ],
  };
  fs.mkdirSync(path.dirname(output), { recursive: true });
  writeJson(output, example);
  return output;
}

module.exports = { ffmpegAvailable, runCinematic, stitchVoiceover, writeExample };
