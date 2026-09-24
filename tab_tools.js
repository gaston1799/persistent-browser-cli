const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { chromium } = require("playwright-core");

function formatTabLabel(tab) {
  const marker = tab.active ? "*" : " ";
  const title = tab.title ? ` | ${tab.title}` : "";
  const stalled = tab.stalled ? " [STALLED]" : "";
  return `${marker} [${tab.id}] ${tab.url}${title}${stalled}`;
}

function isInternalTab(tab) {
  const url = String(tab?.url || "").toLowerCase();
  return (
    url.startsWith("chrome://") ||
    url.startsWith("devtools://") ||
    url.startsWith("edge://") ||
    url.startsWith("chrome-extension://") ||
    url === "about:blank"
  );
}

function isChromeSystemTab(tab) {
  const url = String(tab?.url || "").toLowerCase();
  return (
    url.startsWith("chrome://") ||
    url.startsWith("devtools://") ||
    url.startsWith("edge://") ||
    url.startsWith("chrome-extension://")
  );
}

function normalizeUrl(value) {
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

function cdpTimeoutMs() {
  return Math.min(Math.max(Number(process.env.PBC_CDP_TIMEOUT_MS) || 10000, 1000), 120000);
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function withTimeout(promise, ms, label) {
  let timer = null;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error(`${label} timed out after ${ms}ms`)), ms);
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

async function enumeratePages(browser) {
  const tabs = [];
  let nextId = 0;

  for (const context of browser.contexts()) {
    for (const page of context.pages()) {
      const url = page.url();
      let stalled = false;
      const title = await withTimeout(page.title(), 1200, "tab title").catch(() => {
        stalled = true;
        return "";
      });
      let active = false;
      await withTimeout(page.evaluate(() => document.hasFocus()), 1200, "tab focus").catch(() => {
        stalled = true;
      });
      tabs.push({
        id: String(nextId),
        index: nextId,
        page,
        url,
        title,
        active,
        stalled,
      });
      nextId += 1;
    }
  }

  return tabs;
}

async function connectPages(port, options = {}) {
  const timeout = cdpTimeoutMs();
  const maxAttempts = Math.min(Math.max(Number(options.retries) || 2, 0), 5) + 1;
  let lastError = null;

  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    let browser = null;
    try {
      browser = await chromium.connectOverCDP(`http://127.0.0.1:${port}`, { timeout });
      const tabs = await withTimeout(enumeratePages(browser), timeout + 5000, "CDP page enumeration");
      return { browser, tabs };
    } catch (error) {
      lastError = error;
      if (browser) await browser.close().catch(() => {});
      if (attempt < maxAttempts) await sleep(250 * attempt);
    }
  }

  throw lastError;
}

async function withResolvedTab(port, token, fn) {
  const { browser, tabs } = await connectPages(port);
  try {
    const tab = resolveTab(tabs, token);
    return await fn(tab, browser);
  } finally {
    await browser.close().catch(() => {});
  }
}

function resolveTab(tabs, token) {
  if (!tabs.length) throw new Error("No tabs are open in the persistent browser.");

  const raw = String(token == null ? "active" : token).trim();
  if (!raw || /^(active|current)$/i.test(raw)) {
    const activeVisible = tabs.find((tab) => tab.active && !isInternalTab(tab));
    if (activeVisible) return activeVisible;

    const lastVisible = [...tabs].reverse().find((tab) => !isInternalTab(tab));
    if (lastVisible) return lastVisible;

    const activeUserTab = tabs.find((tab) => tab.active && !isChromeSystemTab(tab));
    if (activeUserTab) return activeUserTab;

    const lastUserTab = [...tabs].reverse().find((tab) => !isChromeSystemTab(tab));
    if (lastUserTab) return lastUserTab;

    const activeAny = tabs.find((tab) => tab.active);
    return activeAny || tabs[tabs.length - 1];
  }

  const byId = raw.replace(/^tab:/i, "").replace(/^p/i, "");
  if (/^\d+$/.test(byId)) {
    const visibleTabs = tabs.filter((tab) => !isInternalTab(tab));
    const visibleByPosition = visibleTabs.find((_, index) => String(index) === byId);
    if (visibleByPosition) return visibleByPosition;

    const visibleByRawId = visibleTabs.find((tab) => tab.id === byId);
    if (visibleByRawId) return visibleByRawId;

    const rawByPosition = tabs.find((_, index) => String(index) === byId);
    if (rawByPosition) return rawByPosition;

    const rawById = tabs.find((tab) => tab.id === byId);
    if (rawById) return rawById;
  }

  const needle = raw.toLowerCase();
  const byUrl = tabs.find((tab) => tab.url.toLowerCase().includes(needle));
  if (byUrl) return byUrl;

  const byTitle = tabs.find((tab) => (tab.title || "").toLowerCase().includes(needle));
  if (byTitle) return byTitle;

  throw new Error(`Could not find a tab matching "${raw}".`);
}

async function listTabs(port, options = {}) {
  return withResolvedTabList(port, options);
}

async function withResolvedTabList(port, options = {}) {
  const { browser, tabs } = await connectPages(port);
  try {
    const includeInternal = Boolean(options.includeInternal);
    return tabs
      .filter((tab) => includeInternal || !isInternalTab(tab))
      .map((tab) => ({
        id: tab.id,
        url: tab.url,
        title: tab.title,
        active: tab.active,
        label: formatTabLabel(tab),
      }));
  } finally {
    await browser.close().catch(() => {});
  }
}

async function activateTab(port, token) {
  return withResolvedTab(port, token, async (tab) => {
    await tab.page.bringToFront();
    return { id: tab.id, url: tab.url, title: tab.title };
  });
}

async function gotoTab(port, token, url) {
  return withResolvedTab(port, token, async (tab) => {
    await tab.page.bringToFront();
    if (normalizeUrl(tab.url) !== normalizeUrl(url)) {
      await tab.page.goto(url, { waitUntil: "domcontentloaded" });
    }
    return { id: tab.id, url: tab.page.url(), title: await tab.page.title().catch(() => tab.title) };
  });
}

async function closeTab(port, token) {
  const { browser, tabs } = await connectPages(port);
  try {
    const tab = resolveTab(tabs, token);
    const result = { id: tab.id, url: tab.url, title: tab.title };
    const shifted = tabs
      .filter((other) => other.index > tab.index && !isInternalTab(other))
      .map((other) => ({ id: other.id, url: other.url, title: other.title }));
    await tab.page.close({ runBeforeUnload: false });
    return { ...result, shifted };
  } finally {
    await browser.close().catch(() => {});
  }
}

async function pruneDuplicateTabs(port, keepToken = null) {
  const { browser, tabs } = await connectPages(port);
  try {
    const keepTab = keepToken ? resolveTab(tabs, keepToken) : null;
    const seen = new Map();
    const closed = [];

    for (const tab of tabs) {
      const key = normalizeUrl(tab.url);
      if (!seen.has(key)) {
        seen.set(key, tab);
        continue;
      }

      const first = seen.get(key);
      const preferred =
        keepTab && (first.id === keepTab.id || tab.id === keepTab.id)
          ? keepTab.id
          : first.active
            ? first.id
            : tab.active
              ? tab.id
              : first.id;
      const loser = preferred === first.id ? tab : first;
      const winner = preferred === first.id ? first : tab;
      seen.set(key, winner);
      await loser.page.close({ runBeforeUnload: false });
      closed.push({ id: loser.id, url: loser.url, title: loser.title });
    }

    return closed;
  } finally {
    await browser.close().catch(() => {});
  }
}

async function reuseOrOpenTab(port, url, options = {}) {
  const { match, token, reuseActive = false } = options;
  const { browser, tabs } = await connectPages(port);
  try {
    const exact = tabs.find((tab) => normalizeUrl(tab.url) === normalizeUrl(url));
    if (exact) {
      await exact.page.bringToFront();
      return { mode: "exact", id: exact.id, url: exact.url, title: exact.title };
    }

    if (token || match || reuseActive) {
      const tab = resolveTab(tabs, token || match || "active");
      await tab.page.bringToFront();
      if (normalizeUrl(tab.url) !== normalizeUrl(url)) {
        await tab.page.goto(url, { waitUntil: "domcontentloaded" });
      }
      return { mode: "reused", id: tab.id, url: tab.page.url(), title: await tab.page.title().catch(() => tab.title) };
    }

    return null;
  } finally {
    await browser.close().catch(() => {});
  }
}

async function listFrames(port, token) {
  return withResolvedTab(port, token, async (tab) => {
    return Promise.all(
      tab.page.frames().map(async (frame, index) => ({
        index,
        name: frame.name() || "",
        url: frame.url(),
        isMain: frame === tab.page.mainFrame(),
        element: await frameElementInfo(frame),
      }))
    );
  });
}

async function inspectFields(port, token, options = {}) {
  return withResolvedTab(port, token, async (tab) => {
    const frame = await resolveFrame(tab.page, options.frame);
    if (!frame) throw new Error(`Could not find a frame matching "${options.frame}".`);

    const controls = await frame.evaluate(() => {
      const nodes = Array.from(document.querySelectorAll("input, select, textarea, button"));
      return nodes.map((node, index) => {
        const tag = node.tagName.toLowerCase();
        const type = tag === "input" ? (node.getAttribute("type") || "text").toLowerCase() : tag;
        const labelText = (() => {
          const aria = node.getAttribute("aria-label");
          if (aria) return aria.trim();
          const labelledBy = node.getAttribute("aria-labelledby");
          if (labelledBy) {
            const text = labelledBy
              .split(/\s+/)
              .map((id) => document.getElementById(id)?.textContent?.trim() || "")
              .filter(Boolean)
              .join(" ");
            if (text) return text;
          }
          if (node.id) {
            const label = document.querySelector(`label[for="${CSS.escape(node.id)}"]`);
            if (label?.textContent) return label.textContent.trim();
          }
          const closest = node.closest("label");
          if (closest?.textContent) return closest.textContent.trim();
          return "";
        })();
        const placeholder = node.getAttribute("placeholder") || "";
        const name = node.getAttribute("name") || "";
        const id = node.id || "";
        const required = node.required || node.getAttribute("aria-required") === "true";
        const disabled = node.disabled;
        const value = "value" in node ? String(node.value || "") : "";
        return {
          index,
          tag,
          type,
          name,
          id,
          label: labelText,
          placeholder,
          required,
          disabled,
          value,
          text: node.textContent?.trim().replace(/\s+/g, " ").slice(0, 120) || "",
        };
      });
    });

    return {
      frame: {
        name: frame.name() || "",
        url: frame.url(),
      },
      controls,
    };
  });
}

function normalizeFrameNeedle(frameNeedle) {
  const needle = String(frameNeedle || "").trim().toLowerCase();
  return needle;
}

function frameMetadataMatches(frame, needle) {
  return (
    (frame.name() || "").toLowerCase().includes(needle) ||
    frame.url().toLowerCase().includes(needle)
  );
}

function iframeInfoMatches(info, needle) {
  if (!info) return false;
  return ["id", "name", "src", "title", "ariaLabel"]
    .map((key) => String(info[key] || "").toLowerCase())
    .some((value) => value.includes(needle));
}

async function frameElementInfo(frame) {
  try {
    const element = await frame.frameElement();
    return await element.evaluate((node) => ({
      id: node.id || "",
      name: node.getAttribute("name") || "",
      src: node.getAttribute("src") || "",
      title: node.getAttribute("title") || "",
      ariaLabel: node.getAttribute("aria-label") || "",
    }));
  } catch {
    return null;
  }
}

async function resolveFrame(page, frameNeedle) {
  const needle = normalizeFrameNeedle(frameNeedle);
  if (!needle) return page.mainFrame();

  const metadataMatch = page.frames().find((frame) => frameMetadataMatches(frame, needle));
  if (metadataMatch) return metadataMatch;

  for (const frame of page.frames()) {
    if (frame === page.mainFrame()) continue;
    if (iframeInfoMatches(await frameElementInfo(frame), needle)) return frame;
  }

  const iframeMatch = await page
    .locator("iframe, frame")
    .evaluateAll((nodes, rawNeedle) => {
      const needleText = String(rawNeedle || "").toLowerCase();
      const matches = [];
      for (let index = 0; index < nodes.length; index += 1) {
        const node = nodes[index];
        const info = {
          index,
          id: node.id || "",
          name: node.getAttribute("name") || "",
          src: node.getAttribute("src") || "",
          title: node.getAttribute("title") || "",
          ariaLabel: node.getAttribute("aria-label") || "",
        };
        const values = [info.id, info.name, info.src, info.title, info.ariaLabel].map((value) => String(value || "").toLowerCase());
        if (values.some((value) => value.includes(needleText))) matches.push(info);
      }
      return matches[0] || null;
    }, needle)
    .catch(() => null);

  if (iframeMatch) {
    const handle = await page.locator("iframe, frame").nth(iframeMatch.index).elementHandle();
    const frame = await handle?.contentFrame();
    await handle?.dispose().catch(() => {});
    if (frame) return frame;
    throw new Error(`Found iframe matching "${frameNeedle}", but it does not have an attached content frame yet.`);
  }

  return null;
}

function looksLikeSelector(target) {
  return /^[.#\[]/.test(target) || /^(input|textarea|select|button|a|label|form|div|span)\b/i.test(target) || /^\/\//.test(target);
}

async function ensureUsableViewport(page) {
  const viewport = await page
    .evaluate(() => ({
      innerWidth: window.innerWidth,
      innerHeight: window.innerHeight,
      visualWidth: window.visualViewport?.width || 0,
      visualHeight: window.visualViewport?.height || 0,
    }))
    .catch(() => null);

  if (
    viewport &&
    viewport.innerWidth >= 100 &&
    viewport.innerHeight >= 100 &&
    viewport.visualWidth >= 100 &&
    viewport.visualHeight >= 100
  ) {
    return;
  }

  await page.setViewportSize({ width: 1280, height: 900 }).catch(() => {});

  const session = await page.context().newCDPSession(page);
  try {
    const { windowId } = await session.send("Browser.getWindowForTarget");
    await session.send("Browser.setWindowBounds", {
      windowId,
      bounds: { windowState: "normal", left: 40, top: 40, width: 1280, height: 900 },
    });
    await page.waitForTimeout(250);
  } catch {
    await session
      .send("Emulation.setDeviceMetricsOverride", {
        width: 1280,
        height: 900,
        deviceScaleFactor: 1,
        mobile: false,
      })
      .catch(() => {});
    await page.waitForTimeout(250);
  } finally {
    await session.detach().catch(() => {});
  }
}

function refsStorePath() {
  return path.join(os.tmpdir(), "pbc", "refs-store.json");
}

function loadRefsStore() {
  try {
    return JSON.parse(fs.readFileSync(refsStorePath(), "utf8"));
  } catch {
    return {};
  }
}

function saveRefsStore(store) {
  fs.mkdirSync(path.dirname(refsStorePath()), { recursive: true });
  fs.writeFileSync(refsStorePath(), JSON.stringify(store), "utf8");
}

function persistTabRefs(tabId, frameUrl, items) {
  try {
    const store = loadRefsStore();
    const key = String(tabId);
    const entries = (store[key] || []).filter((entry) => entry.frameUrl !== frameUrl);
    entries.push({ frameUrl, items, capturedAt: new Date().toISOString() });
    store[key] = entries.slice(-10);
    saveRefsStore(store);
  } catch {
    // Best-effort optimization; never break snapshot over it.
  }
}

function lookupRefSignature(tabId, frameUrl, ref) {
  try {
    const store = loadRefsStore();
    const entries = store[String(tabId)] || [];
    const ordered = [...entries].reverse();
    const entry = ordered.find((candidate) => candidate.frameUrl === frameUrl) || ordered[0];
    if (!entry) return null;
    return entry.items.find((item) => item.ref === ref) || null;
  } catch {
    return null;
  }
}

async function elementState(locator) {
  try {
    return await locator.evaluate((node) => {
      const style = window.getComputedStyle(node);
      const rect = node.getBoundingClientRect();
      return {
        tag: node.tagName.toLowerCase(),
        id: node.id || "",
        name: node.getAttribute("name") || "",
        type: node.getAttribute("type") || "",
        role: node.getAttribute("role") || "",
        ref: node.getAttribute("data-pbc-ref") || "",
        text: (node.innerText || node.textContent || "").trim().replace(/\s+/g, " ").slice(0, 120),
        ariaLabel: node.getAttribute("aria-label") || "",
        display: style.display,
        visibility: style.visibility,
        width: Math.round(rect.width),
        height: Math.round(rect.height),
        visible: style.display !== "none" && style.visibility !== "hidden" && style.visibility !== "collapse" && rect.width > 0 && rect.height > 0,
        disabled: Boolean(node.disabled || node.getAttribute("aria-disabled") === "true"),
      };
    });
  } catch {
    return null;
  }
}

function signatureFromState(state) {
  return { tag: state.tag, id: state.id, name: state.name, type: state.type };
}

function signatureMatches(current, expected) {
  if (current.tag !== expected.tag) return false;
  if (expected.id && expected.id !== current.id) return false;
  if (expected.name && expected.name !== current.name) return false;
  if (expected.type && expected.type !== current.type) return false;
  return true;
}

function describeState(state) {
  const parts = [`<${state.tag}>`];
  if (state.id) parts.push(`#${state.id}`);
  if (state.name) parts.push(`name=${state.name}`);
  if (state.type) parts.push(`type=${state.type}`);
  if (state.ref) parts.push(`ref=${state.ref}`);
  if (state.text) parts.push(JSON.stringify(state.text.slice(0, 40)));
  if (state.disabled) parts.push("disabled");
  if (!state.visible) parts.push(`not visible (display=${state.display}, visibility=${state.visibility}, ${state.width}x${state.height})`);
  return parts.join(" ");
}

function describeSignature(expected) {
  const parts = [`<${expected.tag}>`];
  if (expected.id) parts.push(`#${expected.id}`);
  if (expected.name) parts.push(`name=${expected.name}`);
  if (expected.type) parts.push(`type=${expected.type}`);
  if (expected.label) parts.push(JSON.stringify(String(expected.label).slice(0, 40)));
  return parts.join(" ");
}

async function locatorExists(locator) {
  const count = await locator.count().catch(() => 0);
  return count > 0;
}

async function resolveTargetLocator(frame, raw, options = {}) {
  const { tabId, frameUrl, kind = "input" } = options;
  const trimmed = String(raw || "").trim();
  if (!trimmed) throw new Error("Target is required.");

  if (/^e\d+$/i.test(trimmed)) {
    const ref = trimmed.toLowerCase();
    const locator = frame.locator(`[data-pbc-ref="${ref}"]`).first();
    const expected = lookupRefSignature(tabId, frameUrl, ref);
    if (expected) {
      const state = await elementState(locator);
      if (!state) {
        throw new Error(
          `Ref ${ref} is no longer in the DOM (snapshot had ${describeSignature(expected)}). Run 'pbc tab snapshot' again and use a fresh ref.`
        );
      }
      const current = signatureFromState(state);
      if (!signatureMatches(current, expected)) {
        throw new Error(
          `Ref ${ref} went stale: it now points to ${describeState(state)} but the snapshot recorded ${describeSignature(expected)}. Run 'pbc tab snapshot' again and use a fresh ref.`
        );
      }
    }
    return { locator, mode: "ref" };
  }

  if (looksLikeSelector(trimmed)) {
    return { locator: frame.locator(trimmed).first(), mode: "selector" };
  }

  if (kind === "click") {
    return { locator: frame.getByText(trimmed, { exact: false }).first(), mode: "text" };
  }

  const labelLocator = frame.getByLabel(trimmed, { exact: false }).first();
  if (await locatorExists(labelLocator)) return { locator: labelLocator, mode: "label" };

  const placeholderLocator = frame.getByPlaceholder(trimmed, { exact: false }).first();
  if (await locatorExists(placeholderLocator)) return { locator: placeholderLocator, mode: "placeholder" };

  return { locator: labelLocator, mode: "label" };
}

async function clickLocatorFastFail(locator, options = {}) {
  const timeout = actionTimeoutMs(options);
  const state = await elementState(locator);
  if (state) {
    if (state.disabled) {
      throw new Error(`Cannot click target: ${describeState(state)} is disabled.`);
    }
    if (!state.visible) {
      throw new Error(`Cannot click target: ${describeState(state)} is not visible.`);
    }
  }
  try {
    await locator.click({ timeout });
  } catch (error) {
    const after = await elementState(locator);
    const detail = after ? describeState(after) : "the target element is not in the DOM";
    throw new Error(`Cannot click target: ${detail}. ${error.message}`);
  }
}

function actionTimeoutMs(options = {}) {
  const value = Number(options.timeoutMs);
  if (!Number.isFinite(value) || value <= 0) return 5000;
  return Math.min(Math.max(value, 100), 120000);
}

function clampDelay(value) {
  const ms = Number(value);
  if (!Number.isFinite(ms) || ms < 0) return 40;
  return Math.min(Math.max(ms, 0), 5000);
}

async function snapshotTab(port, token, options = {}) {
  return withResolvedTab(port, token, async (tab) => {
    const frame = await resolveFrame(tab.page, options.frame);
    if (!frame) throw new Error(`Could not find a frame matching "${options.frame}".`);

    const items = await frame.evaluate(() => {
      document.querySelectorAll("[data-pbc-ref]").forEach((node) => node.removeAttribute("data-pbc-ref"));
      const selector = [
        "a",
        "button",
        "input",
        "select",
        "textarea",
        "[role]",
        "[contenteditable='true']",
      ].join(",");

      function getLabel(node) {
        const aria = node.getAttribute("aria-label");
        if (aria) return aria.trim();

        const labelledBy = node.getAttribute("aria-labelledby");
        if (labelledBy) {
          const text = labelledBy
            .split(/\s+/)
            .map((id) => document.getElementById(id)?.textContent?.trim() || "")
            .filter(Boolean)
            .join(" ");
          if (text) return text;
        }

        if (node.id) {
          const label = document.querySelector(`label[for="${CSS.escape(node.id)}"]`);
          if (label?.textContent) return label.textContent.trim();
        }

        const closest = node.closest("label");
        if (closest?.textContent) return closest.textContent.trim();

        return "";
      }

      return Array.from(document.querySelectorAll(selector))
        .filter((node) => {
          const style = window.getComputedStyle(node);
          const rect = node.getBoundingClientRect();
          return (
            style.visibility !== "hidden" &&
            style.display !== "none" &&
            rect.width > 0 &&
            rect.height > 0
          );
        })
        .map((node, index) => {
          const tag = node.tagName.toLowerCase();
          const type = node.getAttribute("type") || "";
          const role = node.getAttribute("role") || "";
          const name = node.getAttribute("name") || "";
          const id = node.id || "";
          const aria = node.getAttribute("aria-label") || "";
          const placeholder = node.getAttribute("placeholder") || "";
          const text = (node.innerText || node.textContent || "").trim().replace(/\s+/g, " ").slice(0, 160);
          const value = "value" in node ? String(node.value || "").slice(0, 160) : "";
          const label = (getLabel(node) || aria || placeholder || text || value).replace(/\s+/g, " ").slice(0, 160);

          node.setAttribute("data-pbc-ref", `e${index}`);

          return {
            ref: `e${index}`,
            tag,
            role,
            type,
            name,
            id,
            label,
            text,
            value,
            disabled: Boolean(node.disabled || node.getAttribute("aria-disabled") === "true"),
          };
        });
    });

    persistTabRefs(tab.id, frame.url(), items);

    return {
      tab: { id: tab.id, url: tab.page.url(), title: await tab.page.title().catch(() => tab.title) },
      frame: { name: frame.name() || "", url: frame.url() },
      items,
    };
  });
}

async function textTab(port, token, options = {}) {
  return withResolvedTab(port, token, async (tab) => {
    const frame = await resolveFrame(tab.page, options.frame);
    if (!frame) throw new Error(`Could not find a frame matching "${options.frame}".`);

    const includeValues = Boolean(options.includeValues);

    const text = await frame.evaluate((opts) => {
      const source = document.body?.innerText || document.documentElement?.textContent || "";
      let output = source.trim().replace(/\n{3,}/g, "\n\n");

      if (opts.includeValues) {
        const valueLines = [];
        const seen = new Set();
        document.querySelectorAll("input, textarea, select").forEach((node) => {
          const type = String(node.getAttribute("type") || "").toLowerCase();
          if (type === "password") return;
          const value = node.value != null ? String(node.value) : "";
          if (!value) return;
          const id = node.id ? `#${node.id}` : "";
          const name = node.getAttribute("name") ? ` name=${JSON.stringify(node.getAttribute("name"))}` : "";
          const placeholder = node.getAttribute("placeholder") ? ` placeholder=${JSON.stringify(node.getAttribute("placeholder"))}` : "";
          const line = `[${node.tagName.toLowerCase()}${id}${name}${placeholder}] = ${JSON.stringify(value)}`;
          if (!seen.has(line)) {
            seen.add(line);
            valueLines.push(line);
          }
        });
        if (valueLines.length) {
          output = `${output}\n\n-- input values --\n${valueLines.join("\n")}`;
        }
      }

      return output;
    }, { includeValues });

    return {
      tab: { id: tab.id, url: tab.page.url(), title: await tab.page.title().catch(() => tab.title) },
      frame: { name: frame.name() || "", url: frame.url() },
      text,
    };
  });
}

async function clickTab(port, token, target, options = {}) {
  return withResolvedTab(port, token, async (tab) => {
    await ensureUsableViewport(tab.page);

    const frame = await resolveFrame(tab.page, options.frame);
    if (!frame) throw new Error(`Could not find a frame matching "${options.frame}".`);

    const raw = String(target || "").trim();
    if (!raw) throw new Error("Click target is required.");

    const { locator, mode } = await resolveTargetLocator(frame, raw, {
      tabId: tab.id,
      frameUrl: frame.url(),
      kind: "click",
    });
    await clickLocatorFastFail(locator, { timeoutMs: options.timeoutMs });

    return { clicked: raw, mode, url: tab.page.url() };
  });
}

async function holdTab(port, token, target, options = {}) {
  return withResolvedTab(port, token, async (tab) => {
    await ensureUsableViewport(tab.page);

    const frame = await resolveFrame(tab.page, options.frame);
    if (!frame) throw new Error(`Could not find a frame matching "${options.frame}".`);

    const raw = String(target || "").trim();
    if (!raw) throw new Error("Hold target is required.");

    const { locator, mode } = await resolveTargetLocator(frame, raw, {
      tabId: tab.id,
      frameUrl: frame.url(),
      kind: "click",
    });

    const state = await elementState(locator);
    if (state) {
      if (state.disabled) throw new Error(`Cannot hold target: ${describeState(state)} is disabled.`);
      if (!state.visible) throw new Error(`Cannot hold target: ${describeState(state)} is not visible.`);
    }

    const minHold = clampHoldMs(options.holdMs);
    const timeout = actionTimeoutMs(options);
    const watch = options.untilGone !== undefined || options.untilVisible || options.untilText;

    const box = await locator.boundingBox();
    if (!box) throw new Error(`Cannot hold target: element has no bounding box (${state ? describeState(state) : raw}).`);

    const page = tab.page;
    const x = Math.round(box.x + box.width / 2);
    const y = Math.round(box.y + box.height / 2);
    await page.mouse.move(x, y);
    await page.mouse.down();

    const started = Date.now();
    const deadline = started + Math.max(minHold, timeout);
    let heldMs = 0;
    let condition = "hold";
    try {
      while (true) {
        heldMs = Date.now() - started;
        if (watch && (await holdConditionMet(frame, locator, options))) {
          condition = holdConditionName(options);
          break;
        }
        if (!watch && heldMs >= minHold) break;
        if (heldMs >= deadline) {
          condition = watch ? "timeout" : "hold";
          break;
        }
        await new Promise((resolve) => setTimeout(resolve, 50));
      }
    } finally {
      await page.mouse.up();
    }

    return { held: raw, mode, heldMs, condition, url: tab.page.url() };
  });
}

async function testHoldTab(port, token, target, options = {}) {
  return withResolvedTab(port, token, async (tab) => {
    await ensureUsableViewport(tab.page);

    const frame = await resolveFrame(tab.page, options.frame);
    if (!frame) throw new Error(`Could not find a frame matching "${options.frame}".`);

    const raw = String(target || "").trim();
    if (!raw) throw new Error("Hold target is required.");

    const { locator, mode } = await resolveTargetLocator(frame, raw, {
      tabId: tab.id,
      frameUrl: frame.url(),
      kind: "click",
    });

    const state = await elementState(locator);
    if (state) {
      if (state.disabled) throw new Error(`Cannot hold target: ${describeState(state)} is disabled.`);
      if (!state.visible) throw new Error(`Cannot hold target: ${describeState(state)} is not visible.`);
    }

    const minHold = clampHoldMs(options.holdMs);
    const timeout = actionTimeoutMs(options);

    await frame.evaluate(installHoldObserver).catch(() => {});

    const box = await locator.boundingBox();
    if (!box) throw new Error(`Cannot hold target: element has no bounding box (${state ? describeState(state) : raw}).`);

    const page = tab.page;
    const x = Math.round(box.x + box.width / 2);
    const y = Math.round(box.y + box.height / 2);
    await page.mouse.move(x, y);
    await page.mouse.down();

    const started = Date.now();
    const deadline = started + Math.max(minHold, timeout);
    let heldMs = 0;
    let firstChangeAt = 0;
    try {
      while (true) {
        heldMs = Date.now() - started;
        const changed = await frame.evaluate(holdObserverCount).catch(() => 0);
        if (changed > 0 && firstChangeAt === 0) firstChangeAt = heldMs;
        if (firstChangeAt > 0 && heldMs >= firstChangeAt + 400) break;
        if (firstChangeAt === 0 && heldMs >= minHold) break;
        if (heldMs >= deadline) break;
        await new Promise((resolve) => setTimeout(resolve, 50));
      }
    } finally {
      await page.mouse.up();
    }

    const mutations = await frame.evaluate(readHoldMutations).catch(() => []);
    return { held: raw, mode, heldMs, firstChangeAt, changed: mutations.length > 0, mutations, url: tab.page.url() };
  });
}

function clampHoldMs(value) {
  const ms = Number(value);
  if (!Number.isFinite(ms) || ms <= 0) return 1500;
  return Math.min(Math.max(ms, 50), 600000);
}

async function holdConditionMet(frame, locator, options) {
  if (options.untilGone === "") {
    return (await locator.count().catch(() => 0)) === 0;
  }
  if (options.untilGone) {
    return (await frame.locator(options.untilGone).count().catch(() => 0)) === 0;
  }
  if (options.untilVisible) {
    return frame.locator(options.untilVisible).first().isVisible().catch(() => false);
  }
  if (options.untilText) {
    return frame
      .evaluate((text) => Boolean(document.body && document.body.innerText.includes(text)), options.untilText)
      .catch(() => false);
  }
  return false;
}

function holdConditionName(options) {
  if (options.untilGone !== undefined) return "until-gone";
  if (options.untilVisible) return "until-visible";
  if (options.untilText) return "until-text";
  return "hold";
}

function installHoldObserver() {
  if (window.__pbcHoldObs) {
    try { window.__pbcHoldObs.disconnect(); } catch (e) {}
  }
  window.__pbcHoldMuts = [];
  const describe = (n) => {
    if (!n) return "?";
    if (n.nodeType === 8) return "comment";
    if (n.nodeType === 3) return "text " + JSON.stringify(String(n.nodeValue || "").slice(0, 40));
    const tag = String(n.tagName || "?").toLowerCase();
    const id = n.id ? "#" + n.id : "";
    let cls = "";
    if (typeof n.className === "string" && n.className) {
      cls = "." + n.className.trim().split(/\s+/).slice(0, 2).join(".");
    }
    const txt = String(n.textContent || "").trim().slice(0, 30);
    return "<" + tag + id + cls + ">" + (txt ? " " + JSON.stringify(txt) : "");
  };
  const push = (line) => {
    window.__pbcHoldMuts.push(line);
    if (window.__pbcHoldMuts.length > 300) {
      try { window.__pbcHoldObs.disconnect(); } catch (e) {}
    }
  };
  const obs = new MutationObserver((muts) => {
    for (const m of muts) {
      if (m.type === "childList") {
        for (const n of m.removedNodes) push("removed " + describe(n));
        for (const n of m.addedNodes) if (n.nodeType === 1) push("added " + describe(n));
      } else if (m.type === "characterData") {
        push("text " + describe(m.target) + " => " + JSON.stringify(String(m.target.nodeValue || "").slice(0, 40)));
      } else if (m.type === "attributes") {
        let v = null;
        try { v = m.target.getAttribute(m.attributeName); } catch (e) {}
        push("attr " + describe(m.target) + " " + m.attributeName + "=" + JSON.stringify(v));
      }
    }
  });
  obs.observe(document.documentElement, {
    subtree: true,
    childList: true,
    characterData: true,
    attributes: true,
  });
  window.__pbcHoldObs = obs;
  return true;
}

function holdObserverCount() {
  return Array.isArray(window.__pbcHoldMuts) ? window.__pbcHoldMuts.length : 0;
}

function readHoldMutations() {
  const arr = Array.isArray(window.__pbcHoldMuts) ? window.__pbcHoldMuts.slice() : [];
  window.__pbcHoldMuts = [];
  try { if (window.__pbcHoldObs) window.__pbcHoldObs.disconnect(); } catch (e) {}
  const out = [];
  for (const line of arr) {
    if (out.length === 0 || out[out.length - 1] !== line) out.push(line);
    if (out.length >= 40) break;
  }
  return out;
}

async function fillLocator(locator, value, options = {}) {
  const timeout = actionTimeoutMs(options);
  try {
    await locator.fill(value, { timeout });
    return "fill";
  } catch (error) {
    const tag = await locator.evaluate((node) => node.tagName.toLowerCase()).catch(() => "");
    if (tag !== "select") throw error;

    try {
      await locator.selectOption({ label: value }, { timeout });
      return "select-label";
    } catch {
      await locator.selectOption(value, { timeout });
      return "select-value";
    }
  }
}

async function fillLocatorFastFail(locator, value, options = {}) {
  const state = await elementState(locator);
  if (state) {
    if (state.disabled) {
      throw new Error(`Cannot fill target: ${describeState(state)} is disabled.`);
    }
    if (!state.visible) {
      throw new Error(`Cannot fill target: ${describeState(state)} is not visible.`);
    }
  }
  try {
    return await fillLocator(locator, value, options);
  } catch (error) {
    const after = await elementState(locator);
    const detail = after ? describeState(after) : "the target element is not in the DOM";
    throw new Error(`Cannot fill target: ${detail}. ${error.message}`);
  }
}

async function fillTab(port, token, target, value, options = {}) {
  return withResolvedTab(port, token, async (tab) => {
    await ensureUsableViewport(tab.page);

    const frame = await resolveFrame(tab.page, options.frame);
    if (!frame) throw new Error(`Could not find a frame matching "${options.frame}".`);

    const raw = String(target || "").trim();
    if (!raw) throw new Error("Fill target is required.");

    const { locator, mode } = await resolveTargetLocator(frame, raw, {
      tabId: tab.id,
      frameUrl: frame.url(),
      kind: "input",
    });
    const method = await fillLocatorFastFail(locator, String(value), { timeoutMs: options.timeoutMs });

    return { filled: raw, mode, method, url: tab.page.url() };
  });
}

async function typeTab(port, token, target, value, options = {}) {
  return withResolvedTab(port, token, async (tab) => {
    await ensureUsableViewport(tab.page);

    const frame = await resolveFrame(tab.page, options.frame);
    if (!frame) throw new Error(`Could not find a frame matching "${options.frame}".`);

    const raw = String(target || "").trim();
    if (!raw) throw new Error("Type target is required.");
    const text = String(value == null ? "" : value);
    const delayMs = clampDelay(options.delayMs);
    const timeout = actionTimeoutMs(options);

    const { locator, mode } = await resolveTargetLocator(frame, raw, {
      tabId: tab.id,
      frameUrl: frame.url(),
      kind: "input",
    });

    if (options.clear) {
      await locator.focus({ timeout });
      await locator.press("ControlOrMeta+a", { timeout }).catch(() => {});
    }

    await locator.pressSequentially(text, { delay: delayMs, timeout });

    return {
      typed: raw,
      mode,
      method: "pressSequentially",
      delayMs,
      clear: Boolean(options.clear),
      url: tab.page.url(),
    };
  });
}

async function uploadTab(port, token, target, filePaths, options = {}) {
  return withResolvedTab(port, token, async (tab) => {
    await ensureUsableViewport(tab.page);

    const frame = await resolveFrame(tab.page, options.frame);
    if (!frame) throw new Error(`Could not find a frame matching "${options.frame}".`);

    const raw = String(target || "").trim();
    if (!raw) throw new Error("Upload target is required.");

    const files = (Array.isArray(filePaths) ? filePaths : [filePaths])
      .map((file) => String(file == null ? "" : file).trim())
      .filter(Boolean)
      .map((file) => path.resolve(file));
    if (!files.length) throw new Error("At least one absolute file path is required.");

    for (const file of files) {
      let stat;
      try {
        stat = fs.statSync(file);
      } catch {
        throw new Error(`File not found: ${file}`);
      }
      if (!stat.isFile()) throw new Error(`Not a regular file: ${file}`);
    }

    const { locator, mode } = await resolveTargetLocator(frame, raw, {
      tabId: tab.id,
      frameUrl: frame.url(),
      kind: "input",
    });

    try {
      await locator.waitFor({ state: "attached", timeout: actionTimeoutMs(options) });
    } catch {
      throw new Error(`Upload target ${JSON.stringify(raw)} was not found in the page.`);
    }

    const state = await elementState(locator);
    const tagType = state
      ? { tag: state.tag, type: state.type }
      : await locator
          .evaluate((node) => ({
            tag: String(node.tagName || "").toLowerCase(),
            type: String((node.getAttribute && node.getAttribute("type")) || "").toLowerCase(),
          }))
          .catch(() => null);

    if (!tagType || tagType.tag !== "input" || tagType.type !== "file") {
      const detail = state ? describeState(state) : JSON.stringify(raw);
      throw new Error(`Upload target is not an <input type="file">: ${detail}`);
    }

    const acceptsMultiple = await locator.evaluate((node) => Boolean(node.multiple)).catch(() => false);
    if (files.length > 1 && !acceptsMultiple) {
      throw new Error("The file input does not support multiple files; pass exactly one file path.");
    }

    // Resolve the element to a CDP node entirely through the public CDP
    // session API (playwright-core 1.59 no longer exposes handle internals):
    // compute a stable CSS path via the locator, get the node's objectId with
    // Runtime.evaluate, verify it is the expected <input type="file"> with
    // DOM.describeNode, then set the paths with DOM.setFileInputFiles.
    const session = await tab.page.context().newCDPSession(frame);
    try {
      const cssPath = await locator.evaluate((node) => {
        if (!node || node.nodeType !== 1) return null;
        if (node.id) return `#${CSS.escape(node.id)}`;
        const parts = [];
        let el = node;
        while (el && el.nodeType === 1 && el !== document.documentElement) {
          if (el.id) {
            parts.unshift(`#${CSS.escape(el.id)}`);
            break;
          }
          let part = el.tagName.toLowerCase();
          if (el.parentElement) {
            const same = Array.from(el.parentElement.children).filter((sibling) => sibling.tagName === el.tagName);
            if (same.length > 1) part += `:nth-of-type(${same.indexOf(el) + 1})`;
          }
          parts.unshift(part);
          el = el.parentElement;
        }
        return parts.join(" > ");
      });
      if (!cssPath) throw new Error(`Upload target ${JSON.stringify(raw)} could not be resolved to a CSS path.`);

      const { result } = await session.send("Runtime.evaluate", {
        expression: `document.querySelector(${JSON.stringify(cssPath)})`,
        returnByValue: false,
      });
      const objectId = result && result.objectId;
      if (!objectId) throw new Error(`Upload target ${JSON.stringify(raw)} could not be resolved to a CDP node id.`);

      const nodeInfo = await session.send("DOM.describeNode", { objectId }).catch(() => null);
      const nodeName = nodeInfo?.node ? String(nodeInfo.node.localName || nodeInfo.node.nodeName || "").toLowerCase() : "";
      const attrs = nodeInfo?.node && Array.isArray(nodeInfo.node.attributes) ? nodeInfo.node.attributes : [];
      let typeAttr = "";
      for (let i = 0; i < attrs.length; i += 2) {
        if (attrs[i] === "type") {
          typeAttr = String(attrs[i + 1] || "").toLowerCase();
          break;
        }
      }
      if (nodeName !== "input" || typeAttr !== "file") {
        throw new Error(
          `Upload target ${JSON.stringify(raw)} is not an <input type="file">: resolved to <${nodeName}${typeAttr ? ` type=${typeAttr}` : ""}>.`
        );
      }

      await session.send("DOM.setFileInputFiles", { files, objectId });
    } finally {
      await session.detach().catch(() => {});
    }

    return { uploaded: raw, mode, files, url: tab.page.url() };
  });
}

function pbcOutputDir() {
  return path.join(__dirname, "output");
}

function safeDownloadName(value) {
  const cleaned = String(value || "")
    .trim()
    .replace(/[^a-zA-Z0-9._-]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 120);
  return cleaned || "download.bin";
}

function filenameFromDisposition(disposition, url) {
  if (disposition) {
    const star = disposition.match(/filename\*\s*=\s*(?:UTF-8''|utf-8'')([^;]+)/i);
    if (star) {
      try {
        return safeDownloadName(decodeURIComponent(star[1].trim()));
      } catch {}
    }
    const plain = disposition.match(/filename\s*=\s*"?([^";]+)"?/i);
    if (plain) return safeDownloadName(plain[1].trim());
  }
  try {
    const parsed = new URL(url);
    const base = path.basename(decodeURIComponent(parsed.pathname));
    if (base && base !== "/") return safeDownloadName(base);
  } catch {}
  return "download.bin";
}

async function fetchInPageAndSave(page, url, outputPath, timeoutMs) {
  const result = await withTimeout(
    page.evaluate(async (targetUrl) => {
      const response = await fetch(targetUrl, { credentials: "include", redirect: "follow" });
      const buffer = await response.arrayBuffer();
      const bytes = new Uint8Array(buffer);
      let binary = "";
      const chunkSize = 0x8000;
      for (let i = 0; i < bytes.length; i += chunkSize) {
        binary += String.fromCharCode.apply(null, bytes.subarray(i, i + chunkSize));
      }
      return {
        status: response.status,
        ok: response.ok,
        bytes: bytes.length,
        b64: btoa(binary),
        contentType: response.headers.get("content-type") || "",
        contentDisposition: response.headers.get("content-disposition") || "",
        finalUrl: response.url || "",
      };
    }, url),
    timeoutMs,
    "download fetch"
  );
  if (!result.ok) throw new Error(`Download failed: HTTP ${result.status} for ${url}`);
  const targetPath =
    outputPath ||
    path.join(pbcOutputDir(), "pbc-downloads", filenameFromDisposition(result.contentDisposition, result.finalUrl || url));
  fs.mkdirSync(path.dirname(targetPath), { recursive: true });
  fs.writeFileSync(targetPath, Buffer.from(result.b64, "base64"));
  return {
    method: "fetch",
    filename: path.basename(targetPath),
    path: targetPath,
    bytes: result.bytes,
    status: result.status,
    contentType: result.contentType,
  };
}

async function downloadTab(port, token, target, outputPath, options = {}) {
  return withResolvedTab(port, token, async (tab) => {
    await ensureUsableViewport(tab.page);

    const frame = await resolveFrame(tab.page, options.frame);
    if (!frame) throw new Error(`Could not find a frame matching "${options.frame}".`);

    const raw = String(target || "").trim();
    if (!raw) throw new Error("Download target is required.");

    const looksLikeUrl = /^(https?|file):\/\//i.test(raw);
    const explicitOutput = outputPath ? path.resolve(outputPath) : null;
    const timeoutMs = actionTimeoutMs(options);

    if (looksLikeUrl) {
      const saved = await fetchInPageAndSave(tab.page, raw, explicitOutput, timeoutMs);
      return { downloaded: raw, mode: "url", ...saved, url: tab.page.url() };
    }

    const { locator } = await resolveTargetLocator(frame, raw, {
      tabId: tab.id,
      frameUrl: frame.url(),
      kind: "click",
    });

    const href = await locator
      .evaluate((node) => {
        const anchor = node.closest ? node.closest("a") : null;
        const hrefEl = anchor || (node.tagName === "A" ? node : null);
        return {
          href: (hrefEl && hrefEl.href) || node.href || node.src || "",
          download: (hrefEl && hrefEl.getAttribute("download")) || "",
        };
      })
      .catch(() => ({ href: "", download: "" }));

    // Prefer the Playwright download event (JS-triggered downloads and
    // Content-Disposition attachments); fall back to an in-page fetch of the
    // resolved href (session cookies still apply) when no event fires.
    const downloads = [];
    const onDownload = (download) => downloads.push(download);
    tab.page.on("download", onDownload);
    let saved = null;
    try {
      await clickLocatorFastFail(locator, { timeoutMs });
      if (downloads.length) {
        const download = downloads[0];
        const suggested = safeDownloadName(
          download.suggestedFilename() || href.download || path.basename(href.href || "download.bin")
        );
        const targetPath = explicitOutput || path.join(pbcOutputDir(), "pbc-downloads", suggested);
        const sourcePath = await download.path().catch(() => null);
        if (sourcePath) {
          fs.mkdirSync(path.dirname(targetPath), { recursive: true });
          fs.copyFileSync(sourcePath, targetPath);
          saved = { method: "download", filename: suggested, path: targetPath, bytes: fs.statSync(targetPath).size };
        }
      }
    } finally {
      tab.page.off("download", onDownload);
    }

    if (!saved) {
      if (!href.href) throw new Error(`Could not resolve a download URL from ${JSON.stringify(raw)}.`);
      saved = await fetchInPageAndSave(tab.page, href.href, explicitOutput, timeoutMs);
    }

    return { downloaded: raw, mode: "link", ...saved, url: tab.page.url() };
  });
}

async function pdfTab(port, token, outputPath, options = {}) {
  return withResolvedTab(port, token, async (tab) => {
    await ensureUsableViewport(tab.page);
    const session = await tab.page.context().newCDPSession(tab.page);
    let data;
    try {
      const result = await session.send("Page.printToPDF", {
        printBackground: true,
        preferCSSPageSize: options.preferCssPageSize === undefined ? true : Boolean(options.preferCssPageSize),
        ...(options.landscape ? { landscape: true } : {}),
        ...(options.scale ? { scale: Math.min(Math.max(Number(options.scale), 0.1), 2) } : {}),
        ...(options.paperWidth ? { paperWidth: Number(options.paperWidth) } : {}),
        ...(options.paperHeight ? { paperHeight: Number(options.paperHeight) } : {}),
        ...(options.pages ? { pageRanges: String(options.pages) } : {}),
      });
      data = result.data;
    } finally {
      await session.detach().catch(() => {});
    }
    fs.mkdirSync(path.dirname(outputPath), { recursive: true });
    fs.writeFileSync(outputPath, Buffer.from(data, "base64"));
    return { path: outputPath, url: tab.page.url() };
  });
}

async function screenshotTab(port, token, outputPath, options = {}) {
  return withResolvedTab(port, token, async (tab) => {
    await ensureUsableViewport(tab.page);
    try {
      await tab.page.screenshot({ path: outputPath, fullPage: Boolean(options.fullPage), timeout: 10000 });
    } catch {
      const session = await tab.page.context().newCDPSession(tab.page);
      try {
        const image = await session.send("Page.captureScreenshot", {
          format: "png",
          fromSurface: true,
          captureBeyondViewport: Boolean(options.fullPage),
        });
        fs.mkdirSync(path.dirname(outputPath), { recursive: true });
        fs.writeFileSync(outputPath, Buffer.from(image.data, "base64"));
      } finally {
        await session.detach().catch(() => {});
      }
    }
    return { path: outputPath, url: tab.page.url() };
  });
}

async function evalTab(port, token, source, options = {}) {
  return withResolvedTab(port, token, async (tab) => {
    const frame = await resolveFrame(tab.page, options.frame);
    if (!frame) throw new Error(`Could not find a frame matching "${options.frame}".`);

    const value = await frame.evaluate(async (script) => {
      const AsyncFunction = Object.getPrototypeOf(async function () {}).constructor;
      let lastError;
      for (const body of ["return (" + script + ");", script]) {
        try {
          return await new AsyncFunction(body)();
        } catch (error) {
          lastError = error;
        }
      }
      if (lastError instanceof SyntaxError) {
        throw new Error("tab eval: inline JavaScript did not compile in the page. If you passed quotes inside the script from cmd.exe/PowerShell, the shell may have mangled them - use --base64 <b64> or --file <path> instead. Detail: " + (lastError && lastError.message));
      }
      throw lastError;
    }, source);

    return {
      tab: { id: tab.id, url: tab.page.url(), title: await tab.page.title().catch(() => tab.title) },
      frame: { name: frame.name() || "", url: frame.url() },
      value,
    };
  });
}

async function requestBrowserClose(port) {
  let response;
  try {
    response = await fetch(`http://127.0.0.1:${port}/json/version`);
  } catch (error) {
    const code = String(error?.cause?.code || error?.code || "");
    if (code === "ECONNREFUSED" || code === "UND_ERR_SOCKET" || error instanceof TypeError) {
      return { alreadyClosed: true };
    }
    throw error;
  }
  if (!response.ok) {
    throw new Error(`Could not read CDP version endpoint on port ${port}.`);
  }

  const data = await response.json();
  if (!data.webSocketDebuggerUrl) {
    throw new Error(`CDP websocket URL is missing on port ${port}.`);
  }

  await new Promise((resolve, reject) => {
    let sent = false;
    let settled = false;
    const ws = new WebSocket(data.webSocketDebuggerUrl);
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      try {
        ws.close();
      } catch {}
      reject(new Error("Timed out while requesting Browser.close."));
    }, 8000);

    function finish(error = null) {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      try {
        ws.close();
      } catch {}
      if (error) reject(error);
      else resolve();
    }

    ws.addEventListener("open", () => {
      sent = true;
      ws.send(JSON.stringify({ id: 1, method: "Browser.close" }));
    });

    ws.addEventListener("message", (event) => {
      try {
        const message = JSON.parse(String(event.data || "{}"));
        if (message.id !== 1) return;
        if (message.error) {
          finish(new Error(message.error.message || "Browser.close failed."));
          return;
        }
        finish();
      } catch (error) {
        finish(error);
      }
    });

    ws.addEventListener("error", () => {
      finish();
    });

    ws.addEventListener("close", () => {
      finish();
    });
  });

  return { alreadyClosed: false };
}

async function saveAndCloseBrowser(port) {
  const closedTabs = [];
  let targets = [];
  try {
    const response = await fetch(`http://127.0.0.1:${port}/json/list`);
    if (response.ok) {
      targets = await response.json();
    }
  } catch (error) {
    if (String(error?.cause?.code || error?.code || "") === "ECONNREFUSED") {
      return { closedTabs, browserClose: { alreadyClosed: true } };
    }
    throw error;
  }

  for (const target of [...targets].reverse()) {
    if (target.type !== "page") continue;
    const info = {
      id: target.id || target.targetId || "",
      url: target.url || "",
      title: target.title || "",
    };
    try {
      const closeResponse = await fetch(`http://127.0.0.1:${port}/json/close/${target.id || target.targetId}`);
      if (!closeResponse.ok) {
        closedTabs.push({ ...info, error: `HTTP ${closeResponse.status}` });
        continue;
      }
      closedTabs.push(info);
    } catch (error) {
      if (String(error?.cause?.code || error?.code || "") === "ECONNREFUSED") {
        closedTabs.push(info);
        return { closedTabs, browserClose: { alreadyClosed: true } };
      }
      closedTabs.push({ ...info, error: error.message || String(error) });
    }
  }

  const browserClose = await requestBrowserClose(port);
  return { closedTabs, browserClose };
}

async function pressKey(port, token, key, options = {}) {
  return withResolvedTab(port, token, async (tab) => {
    await ensureUsableViewport(tab.page);
    const frame = await resolveFrame(tab.page, options.frame);
    if (!frame) throw new Error(`Could not find a frame matching "${options.frame}".`);
    const raw = String(key || "").trim();
    if (!raw) throw new Error("Key is required.");
    await tab.page.keyboard.press(raw);
    return { pressed: raw, url: tab.page.url() };
  });
}

async function listCdpTargets(port) {
  const response = await fetch(`http://127.0.0.1:${port}/json`).catch(() => null);
  if (!response || !response.ok) throw new Error(`CDP /json endpoint not reachable on port ${port}.`);
  const targets = await response.json().catch(() => []);
  return (targets || []).map((target) => ({
    id: target.id,
    type: target.type || "?",
    url: target.url || "",
    title: target.title || "",
    webSocket: Boolean(target.webSocketDebuggerUrl),
  }));
}

function killOversizedRenderers(thresholdGb = 2, profileMarker = "codex-tools\\pbc") {
  const script = [
    `$threshold = ${thresholdGb} * 1GB`,
    `$marker = '${profileMarker}'`,
    `$procs = Get-CimInstance Win32_Process -Filter "Name='chrome.exe'" | Where-Object { $_.CommandLine -match [regex]::Escape($marker) -and $_.WorkingSetSize -gt $threshold }`,
    `$procs | ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue; Write-Output $_.ProcessId }`,
  ].join("\r\n");
  const { execSync } = require("child_process");
  const os = require("os");
  const path = require("path");
  const fs = require("fs");
  const tmp = path.join(os.tmpdir(), `pbc-heal-${process.pid}.ps1`);
  try {
    fs.writeFileSync(tmp, script, "utf8");
    const out = execSync(`powershell -NoProfile -ExecutionPolicy Bypass -File "${tmp}"`, {
      encoding: "utf8",
      windowsHide: true,
      timeout: 20000,
    });
    return out.split(/\r?\n/).map((s) => s.trim()).filter(Boolean);
  } catch {
    return [];
  } finally {
    try { fs.unlinkSync(tmp); } catch {}
  }
}

async function healStalledTabs(port, options = {}) {
  const thresholdGb = Number(options.thresholdGb) > 0 ? Number(options.thresholdGb) : 2;
  let connection;
  try {
    connection = await connectPages(port, { retries: 0 });
  } catch (error) {
    const killed = killOversizedRenderers(thresholdGb);
    if (killed.length) {
      await sleep(2500);
      connection = await connectPages(port, { retries: 0 }).catch(() => null);
      if (!connection) throw error;
      return {
        closed: killed.map((pid) => ({ id: pid, url: "(renderer pid killed)", closed: true })),
        reconnect: true,
      };
    }
    throw error;
  }
  try {
    const targets = await listCdpTargets(port).catch(() => []);
    const closed = [];
    for (const tab of connection.tabs) {
      if (!tab.stalled) continue;
      const match = targets.find((target) => target.type === "page" && target.url === tab.url);
      const ok = match ? await closeCdpTarget(port, match.id) : false;
      closed.push({ id: tab.id, url: tab.url, closed: ok });
    }
    return { closed };
  } finally {
    await connection.browser.close().catch(() => {});
  }
}

module.exports = {
  activateTab,
  clickTab,
  closeTab,
  evalTab,
  fillTab,
  listCdpTargets,
  healStalledTabs,
  pressKey,
  gotoTab,
  holdTab,
  testHoldTab,
  inspectFields,
  isInternalTab,
  listFrames,
  listTabs,
  pruneDuplicateTabs,
  saveAndCloseBrowser,
  screenshotTab,
  snapshotTab,
  textTab,
  typeTab,
  uploadTab,
  downloadTab,
  pdfTab,
  reuseOrOpenTab,
  resolveFrame,
  withResolvedTab,
};
