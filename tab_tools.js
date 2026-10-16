const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { chromium } = require("playwright-core");
const { USER_DATA_DIR } = require("./config");

const AGENT_CURSOR_STATE_FILE = path.join(os.tmpdir(), "pbc-agent-cursor-state.json");

function readAgentCursorState(port) {
  try {
    const state = JSON.parse(fs.readFileSync(AGENT_CURSOR_STATE_FILE, "utf8"));
    const value = state?.[String(port)];
    return Number.isFinite(value?.x) && Number.isFinite(value?.y) ? value : null;
  } catch {
    return null;
  }
}

function writeAgentCursorState(port, x, y) {
  let state = {};
  try { state = JSON.parse(fs.readFileSync(AGENT_CURSOR_STATE_FILE, "utf8")); } catch {}
  state[String(port)] = { x, y, updatedAt: Date.now() };
  try { fs.writeFileSync(AGENT_CURSOR_STATE_FILE, JSON.stringify(state), "utf8"); } catch {}
}

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
      if (browser) await disconnectBrowser(browser).catch(() => {});
      // A tab that has stopped answering CDP can never be attached to, so retrying
      // only burns the same timeout again. Detect that on the first failure and fail
      // fast with an actionable error instead of three identical waits.
      if (attempt === 1 && /connectOverCDP|Timeout/i.test(String(error?.message || ""))) {
        const unresponsive = await findUnresponsiveTabs(port).catch(() => []);
        if (unresponsive.length) {
          // Upstream (playwright PR #42883, unmerged) fixes this by bounding the per-page attach
          // wait to 3s so a frozen tab cannot hold connectOverCDP. We cannot patch playwright-core's
          // internals, so emulate the intent: a sleeping / Memory-Saver-discarded tab answers again
          // once it is activated, so revive the offenders and retry before giving up.
          const fix = String(process.env.PBC_CDP_AUTOFIX || "revive").trim().toLowerCase();
          if (fix !== "off") {
            const acted = fix === "close"
              ? await closeUnresponsiveTargets(port, unresponsive)
              : await reviveUnresponsiveTargets(port, unresponsive);
            if (acted.length) {
              await sleep(1200);
              lastError = new Error(
                `${error?.message || error} (auto-${fix} applied to ${acted.length} unresponsive tab(s): ${acted.map((tab) => `[${tab.index}] ${tab.url || tab.title || "(no url)"}`).join(", ")}; retrying)`
              );
              continue;
            }
          }
          throw buildUnresponsiveTabsError(unresponsive, error);
        }
      }
      if (attempt < maxAttempts) await sleep(250 * attempt);
    }
  }

  // A tab whose renderer has stopped answering CDP blocks connectOverCDP for the
  // WHOLE browser, so every Playwright-backed command fails while direct-path
  // commands (eval/text/snapshot/ref clicks) keep working. Name the culprit tab
  // instead of surfacing a bare connect timeout.
  const unresponsive = await findUnresponsiveTabs(port, timeout).catch(() => []);
  if (unresponsive.length) throw buildUnresponsiveTabsError(unresponsive, lastError);

  throw lastError;
}

function buildUnresponsiveTabsError(unresponsive, lastError) {
  const names = unresponsive
    .map((tab) => `[${tab.index}] ${tab.url || tab.title || "(no url)"}`)
    .join(", ");
  return new Error(
    `Playwright could not attach to the browser because one or more tabs are not answering CDP: ${names}. ` +
      "Because connectOverCDP waits on every tab, that blocks all Playwright-backed PBC commands (fill, type, selector/text clicks) even for healthy tabs. " +
      `Recover with: pbc tab unstick ${unresponsive[0].index}   (browser-level close; your other tabs are unaffected). ` +
      "Verify first with a direct-path read such as `pbc tab text <index>` - it bypasses Playwright, so it tells you which tab is really dead; a heavy page can stall for 8s+ under load without being wedged. " +
      "If the tab is only asleep/discarded it can usually be revived by clicking it (PBC tries this automatically unless PBC_CDP_AUTOFIX=off). " +
      `Original error: ${lastError?.message || lastError}`
  );
}

async function findUnresponsiveTabs(port, probeTimeoutMs = 4000) {
  const targets = (await listCdpTargets(port).catch(() => [])).filter((target) => target.type === "page");
  const unresponsive = [];
  for (let index = 0; index < targets.length; index += 1) {
    // A heavy page can miss a single short probe while it is mid-render, so only
    // report a tab when it fails twice. A false positive here would tell the
    // operator to close a healthy tab.
    let alive = await probeDirectPageLiveness(port, targets[index].id, probeTimeoutMs).catch(() => false);
    if (!alive) {
      await sleep(400);
      alive = await probeDirectPageLiveness(port, targets[index].id, probeTimeoutMs).catch(() => false);
    }
    if (!alive) unresponsive.push({ index, id: targets[index].id, url: targets[index].url, title: targets[index].title });
  }
  return unresponsive;
}

// Wake a sleeping / discarded tab so its renderer answers CDP again. Non-destructive:
// activating a tab is what Chrome itself does when the user clicks it.
async function reviveUnresponsiveTargets(port, tabs) {
  const acted = [];
  for (const tab of tabs) {
    if (!tab.id) continue;
    const response = await fetch(`http://127.0.0.1:${port}/json/activate/${tab.id}`).catch(() => null);
    if (response && response.ok) acted.push({ ...tab, action: "activate" });
  }
  return acted;
}

// Opt-in (PBC_CDP_AUTOFIX=close): close the offending targets instead of reviving them.
async function closeUnresponsiveTargets(port, tabs) {
  const acted = [];
  for (const tab of tabs) {
    if (!tab.id) continue;
    const response = await fetch(`http://127.0.0.1:${port}/json/close/${tab.id}`).catch(() => null);
    if (response && response.ok) acted.push({ ...tab, action: "close" });
  }
  return acted;
}

async function disconnectBrowser(browser) {
  if (!browser) return;
  // connectOverCDP exposes Chrome's persistent context. A normal browser.close()
  // sends Browser.close to Chrome, which shuts down the user-owned browser and
  // causes its tabs to reload when the supervisor brings it back. Use
  // Playwright's connection-only close path so this CLI detaches without
  // closing the attached Chrome instance.
  browser._shouldCloseConnectionOnClose = true;
  // Playwright's built-in connection-only close path normally gets this event
  // from its remote-browser connector. connectOverCDP does not wire it, so
  // mirror that connector's local disconnected notification before closing.
  browser._connection.once("close", () => {
    setTimeout(() => browser._didClose(), 0);
  });
  await browser.close();
}

async function withResolvedTab(port, token, fn) {
  const { browser, tabs } = await connectPages(port);
  try {
    const tab = resolveTab(tabs, token);
    return await fn(tab, browser);
  } finally {
    await disconnectBrowser(browser).catch(() => {});
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
  const tabs = await listDirectPageTargets(port);
  const includeInternal = Boolean(options.includeInternal);
  return tabs
    .filter((tab) => includeInternal || !isInternalTab(tab))
    .map((tab) => ({
      id: tab.id,
      url: tab.url,
      title: tab.title,
      active: false,
      label: formatTabLabel(tab),
    }));
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
    await disconnectBrowser(browser).catch(() => {});
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
    await disconnectBrowser(browser).catch(() => {});
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
    await disconnectBrowser(browser).catch(() => {});
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
    await disconnectBrowser(browser).catch(() => {});
  }
}

async function listFrames(port, token) {
  const tabs = await listDirectPageTargets(port);
  const tab = resolveTab(tabs, token);
  return withDirectPageSession(tab, async (send) => {
    const result = await send("Page.getFrameTree");
    const frames = [];

    async function visit(node, isMain = false) {
      const frame = node?.frame || {};
      let element = null;
      if (!isMain && frame.id) {
        try {
          const owner = await send("DOM.getFrameOwner", { frameId: frame.id });
          const described = owner?.backendNodeId
            ? await send("DOM.describeNode", { backendNodeId: owner.backendNodeId })
            : null;
          const attrs = described?.node?.attributes || [];
          const attributes = {};
          for (let index = 0; index < attrs.length; index += 2) {
            attributes[attrs[index]] = attrs[index + 1] || "";
          }
          element = {
            id: attributes.id || "",
            name: attributes.name || "",
            src: attributes.src || "",
          };
        } catch {}
      }
      frames.push({
        index: frames.length,
        name: frame.name || "",
        url: frame.url || "",
        isMain,
        element,
      });
      for (const child of node?.childFrames || []) await visit(child, false);
    }

    await visit(result?.frameTree, true);
    return frames;
  });
}

function collectFieldControlsInPage() {
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
}

async function inspectFields(port, token, options = {}) {
  if (!options.frame) {
    const tabs = await listDirectPageTargets(port);
    const tab = resolveTab(tabs, token);
    const controls = await directPageEvaluate(tab, `(${collectFieldControlsInPage.toString()})()`);
    return { frame: { name: "", url: tab.url }, controls };
  }

  return withResolvedTab(port, token, async (tab) => {
    const frame = await resolveFrame(tab.page, options.frame);
    if (!frame) throw new Error(`Could not find a frame matching "${options.frame}".`);

    const controls = await frame.evaluate(collectFieldControlsInPage);

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
  const value = String(target || "").trim();
  if (!value) return false;
  // Explicit prefixes win; resolveTargetLocator handles them separately, so "text="
  // must never fall through to the tag heuristic below.
  if (/^(text|label|placeholder)=/i.test(value)) return false;
  if (/^(css|xpath)=/i.test(value)) return true;
  if (/^\/\//.test(value)) return true;
  // A phrase containing whitespace is button/link text, not a selector. Without this
  // guard "Select A Subcategory" matched the tag list via "select\b" and was handed to
  // locator(), which then sat through Playwright's default timeouts before failing.
  // For a real descendant selector pass an explicit "css=" prefix.
  if (/\s/.test(value)) return false;
  return /^[.#\[]/.test(value) || /^(input|textarea|select|button|a|label|form|div|span)\b/i.test(value);
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
    const keys = [String(tabId), `url:${frameUrl}`];
    for (const key of keys) {
      const entries = (store[key] || []).filter((entry) => entry.frameUrl !== frameUrl);
      entries.push({ frameUrl, items, capturedAt: new Date().toISOString() });
      store[key] = entries.slice(-10);
    }
    saveRefsStore(store);
  } catch {
    // Best-effort optimization; never break snapshot over it.
  }
}

function lookupRefSignature(tabId, frameUrl, ref) {
  try {
    const store = loadRefsStore();
    const entries = store[`url:${frameUrl}`] || store[String(tabId)] || [];
    const ordered = [...entries].reverse();
    const entry = ordered.find((candidate) => candidate.frameUrl === frameUrl) || ordered[0];
    if (!entry) return null;
    return entry.items.find((item) => item.ref === ref) || null;
  } catch {
    return null;
  }
}

async function elementState(locator, timeoutMs = actionTimeoutMs()) {
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
    }, undefined, { timeout: timeoutMs });
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

// Prefer a visible text match: the first DOM match is often a hidden option inside a
// dropdown portal, and waiting on it used to consume Playwright's default timeouts.
async function pickVisibleTextLocator(frame, text) {
  const match = frame.getByText(text, { exact: false });
  try {
    const visible = match.filter({ visible: true }).first();
    if (await locatorExists(visible)) return visible;
  } catch {}
  return match.first();
}

async function resolveTargetLocator(frame, raw, options = {}) {
  const { tabId, frameUrl, kind = "input" } = options;
  const trimmed = String(raw || "").trim();
  if (!trimmed) throw new Error("Target is required.");

  if (/^e\d+$/i.test(trimmed)) {
    const ref = trimmed.toLowerCase();
    const expected = lookupRefSignature(tabId, frameUrl, ref);
    // Snapshots must not annotate the live page: some SPAs (notably YouTube)
    // observe DOM mutations and may re-render in response. Resolve refs through
    // a structural XPath captured during the read-only snapshot instead.
    const locator = expected?.selector
      ? frame.locator(`xpath=${expected.selector}`).first()
      : frame.locator(`[data-pbc-ref="${ref}"]`).first();
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

  const prefixed = /^(text|label|placeholder)=(.+)$/i.exec(trimmed);
  if (prefixed) {
    const needle = prefixed[2].trim();
    const prefix = prefixed[1].toLowerCase();
    if (prefix === "text") return { locator: await pickVisibleTextLocator(frame, needle), mode: "text" };
    if (prefix === "label") return { locator: frame.getByLabel(needle, { exact: false }).first(), mode: "label" };
    return { locator: frame.getByPlaceholder(needle, { exact: false }).first(), mode: "placeholder" };
  }

  if (looksLikeSelector(trimmed)) {
    return { locator: frame.locator(trimmed).first(), mode: "selector" };
  }

  if (kind === "click") {
    return { locator: await pickVisibleTextLocator(frame, trimmed), mode: "text" };
  }

  const labelLocator = frame.getByLabel(trimmed, { exact: false }).first();
  if (await locatorExists(labelLocator)) return { locator: labelLocator, mode: "label" };

  const placeholderLocator = frame.getByPlaceholder(trimmed, { exact: false }).first();
  if (await locatorExists(placeholderLocator)) return { locator: placeholderLocator, mode: "placeholder" };

  return { locator: labelLocator, mode: "label" };
}

async function clickLocatorFastFail(locator, options = {}) {
  const timeout = actionTimeoutMs(options);
  const button = options.button === "right" ? "right" : "left";
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
    await locator.click({ timeout, button });
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

async function listDirectPageTargets(port) {
  const response = await fetch(`http://127.0.0.1:${port}/json/list`);
  if (!response.ok) throw new Error(`Could not read CDP targets on port ${port}.`);
  const targets = (await response.json()).filter((target) => target.type === "page");
  return targets.map((target, index) => ({
    id: String(index),
    index,
    targetId: target.id || target.targetId || "",
    port,
    url: target.url || "",
    title: target.title || "",
    active: false,
    webSocketDebuggerUrl: target.webSocketDebuggerUrl || "",
  }));
}

// Build an actionable error when the page-CDP watchdog fires.
// A renderer whose main thread is executing long-running JavaScript cannot answer
// CDP at all, and CDP cannot cancel that JavaScript (Runtime.terminateExecution is
// served by the very thread that is blocked). Raising PBC_CDP_TIMEOUT_MS therefore
// does not help; the only reliable recovery is a browser-level target close.
function describeDirectPageSessionTimeout(sessionStartedAt, pending, alive) {
  const elapsedMs = Date.now() - sessionStartedAt;
  const inFlight = [...pending.values()];
  const waiting = inFlight.length
    ? inFlight.map((entry) => `${entry.method} (${Date.now() - entry.startedAt}ms)`).join(", ")
    : "no in-flight command";
  const head = `Direct page CDP session timed out after ${elapsedMs}ms (watchdog PBC_CDP_TIMEOUT_MS=${cdpTimeoutMs()}). Still waiting on: ${waiting}.`;
  if (alive) {
    return [
      head,
      "A follow-up probe answered, so the tab is still healthy: the page was busy (e.g. a heavy SPA re-render) rather than wedged.",
      "Simply retry, or raise PBC_CDP_TIMEOUT_MS for heavy pages. Do not close the tab.",
    ].join(" ");
  }
  return [
    head,
    "A follow-up probe also failed, so the page main thread is not answering right now, usually because long-running JavaScript is still executing.",
    "CDP cannot cancel that JavaScript, so raising PBC_CDP_TIMEOUT_MS will not clear this.",
    "Retry once first: if the next call answers, the tab was only temporarily busy and must not be closed.",
    "If it stays unresponsive, recover with: pbc tab unstick active   (browser-level close; add --reopen to reload the URL).",
  ].join(" ");
}

// Distinguish "this page is momentarily busy" from "this renderer is blocked" using a
// fresh, short-lived session. The blocked case cannot be cancelled over CDP, so this
// distinction decides whether retrying or closing the tab is the correct advice.
async function probeDirectPageLiveness(port, targetId, timeoutMs = 3000) {
  if (!targetId) return false;
  let response;
  try {
    response = await fetch(`http://127.0.0.1:${port}/json/version`);
  } catch {
    return false;
  }
  if (!response.ok) return false;
  const version = await response.json().catch(() => null);
  if (!version || !version.webSocketDebuggerUrl) return false;
  return new Promise((resolve) => {
    let settled = false;
    let timer = null;
    const ws = new WebSocket(version.webSocketDebuggerUrl);
    const done = (value) => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      try { ws.close(); } catch {}
      resolve(value);
    };
    timer = setTimeout(() => done(false), timeoutMs);
    ws.addEventListener("open", () => {
      ws.send(JSON.stringify({ id: 1, method: "Target.attachToTarget", params: { targetId, flatten: true } }));
    });
    ws.addEventListener("message", (event) => {
      let message;
      try { message = JSON.parse(String(event.data || "{}")); } catch { return; }
      if (message.id === 1) {
        const sessionId = message.result?.sessionId || "";
        if (!sessionId) return done(false);
        ws.send(
          JSON.stringify({
            id: 2,
            method: "Runtime.evaluate",
            params: { expression: "1", returnByValue: true },
            sessionId,
          })
        );
        return;
      }
      if (message.id === 2) done(message.result?.result?.value === 1);
    });
    ws.addEventListener("error", () => done(false));
  });
}

async function withDirectPageSession(target, fn) {
  if (!target.targetId) throw new Error("The selected page has no CDP target id.");
  const response = await fetch(`http://127.0.0.1:${target.port}/json/version`);
  if (!response.ok) throw new Error(`Could not read CDP version endpoint on port ${target.port}.`);
  const version = await response.json();
  if (!version.webSocketDebuggerUrl) throw new Error("The browser CDP websocket URL is missing.");
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(version.webSocketDebuggerUrl);
    let settled = false;
    let sessionId = "";
    let nextId = 1;
    const pending = new Map();
    const eventWaiters = new Set();
    const sessionStartedAt = Date.now();
    const timer = setTimeout(() => {
      void (async () => {
        const alive = await probeDirectPageLiveness(target.port, target.targetId).catch(() => false);
        finish(new Error(describeDirectPageSessionTimeout(sessionStartedAt, pending, alive)));
      })();
    }, cdpTimeoutMs());

    function finish(error, value) {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      for (const waiter of pending.values()) waiter.reject(error || new Error("Direct page CDP session closed."));
      pending.clear();
      for (const waiter of eventWaiters) waiter.reject(error || new Error("Direct page CDP session closed."));
      eventWaiters.clear();
      try { ws.close(); } catch {}
      if (error) reject(error);
      else resolve(value);
    }

    function send(method, params = {}, useSession = true) {
      return new Promise((resolveMessage, rejectMessage) => {
        const id = nextId++;
        pending.set(id, { resolve: resolveMessage, reject: rejectMessage, method, startedAt: Date.now() });
        ws.send(JSON.stringify({ id, method, params, ...(useSession && sessionId ? { sessionId } : {}) }));
      });
    }

    function waitForEvent(method, timeoutMs = 1000) {
      return new Promise((resolveEvent, rejectEvent) => {
        const waiter = { method, resolve: resolveEvent, reject: rejectEvent, timer: null };
        waiter.timer = setTimeout(() => {
          eventWaiters.delete(waiter);
          rejectEvent(new Error(`Timed out waiting for CDP event ${method}.`));
        }, timeoutMs);
        eventWaiters.add(waiter);
      });
    }

    ws.addEventListener("open", async () => {
      try {
        const attached = await send("Target.attachToTarget", { targetId: target.targetId, flatten: true }, false);
        sessionId = attached?.sessionId || "";
        if (!sessionId) throw new Error("CDP did not return a page session id.");
        finish(null, await fn((method, params) => send(method, params, true), waitForEvent));
      } catch (error) {
        finish(error);
      }
    });
    ws.addEventListener("message", (event) => {
      try {
        const message = JSON.parse(String(event.data || "{}"));
        if (message.method) {
          for (const waiter of [...eventWaiters]) {
            if (waiter.method !== message.method) continue;
            clearTimeout(waiter.timer);
            eventWaiters.delete(waiter);
            waiter.resolve(message.params || {});
          }
        }
        if (!message.id || !pending.has(message.id)) return;
        const waiter = pending.get(message.id);
        pending.delete(message.id);
        if (message.error) waiter.reject(new Error(message.error.message || "Direct page CDP command failed."));
        else waiter.resolve(message.result);
      } catch (error) {
        finish(error);
      }
    });
    ws.addEventListener("error", () => finish(new Error("Direct page CDP connection failed.")));
  });
}

async function directPageEvaluate(target, expression) {
  const evaluation = await withDirectPageSession(target, (send) =>
    send("Runtime.evaluate", { expression, returnByValue: true, awaitPromise: true })
  );
  if (evaluation?.exceptionDetails) {
    const detail = evaluation.exceptionDetails.exception?.description || evaluation.exceptionDetails.text;
    throw new Error(detail || "Direct page evaluation threw an exception.");
  }
  return evaluation?.result?.value;
}

async function directPageSetFileInputFiles(target, expression, files) {
  return withDirectPageSession(target, async (send) => {
    const evaluation = await send("Runtime.evaluate", {
      expression,
      returnByValue: false,
      awaitPromise: true,
    });
    if (evaluation?.exceptionDetails) {
      const detail = evaluation.exceptionDetails.exception?.description || evaluation.exceptionDetails.text;
      throw new Error(detail || "Upload target resolution threw an exception.");
    }
    const objectId = evaluation?.result?.objectId;
    if (!objectId) throw new Error("Upload target could not be resolved to a CDP node.");

    const nodeInfo = await send("DOM.describeNode", { objectId });
    const node = nodeInfo?.node;
    const nodeName = String(node?.localName || node?.nodeName || "").toLowerCase();
    const attrs = Array.isArray(node?.attributes) ? node.attributes : [];
    let typeAttr = "";
    let acceptsMultiple = false;
    for (let index = 0; index < attrs.length; index += 2) {
      if (attrs[index] === "type") typeAttr = String(attrs[index + 1] || "").toLowerCase();
      if (attrs[index] === "multiple") acceptsMultiple = true;
    }
    if (nodeName !== "input" || typeAttr !== "file") {
      throw new Error(`Upload target is not an <input type="file">: resolved to <${nodeName}${typeAttr ? ` type=${typeAttr}` : ""}>.`);
    }
    if (files.length > 1 && !acceptsMultiple) {
      throw new Error("The file input does not support multiple files; pass exactly one file path.");
    }

    await send("DOM.setFileInputFiles", { files, objectId });
    return { acceptsMultiple };
  });
}

async function directPageUploadThroughChooser(target, expected, files, timeoutMs = 8000) {
  await fetch(`http://127.0.0.1:${target.port}/json/activate/${target.targetId}`).catch(() => {});
  const persisted = readAgentCursorState(target.port);
  return withDirectPageSession(target, async (send, waitForEvent) => {
    await send("Page.enable");
    await send("Page.setInterceptFileChooserDialog", { enabled: true });
    try {
      const evaluation = await send("Runtime.evaluate", {
        expression: `document.evaluate(${JSON.stringify(expected.selector)}, document, null, XPathResult.FIRST_ORDERED_NODE_TYPE, null).singleNodeValue`,
        returnByValue: false,
      });
      const objectId = evaluation?.result?.objectId;
      if (!objectId) throw new Error("Upload button is no longer in the page. Run a fresh snapshot.");

      const inspected = await send("Runtime.callFunctionOn", {
        objectId,
        functionDeclaration: `function (expected, persisted) {
          const current = { tag: this.tagName.toLowerCase(), id: this.id || "", name: this.getAttribute("name") || "", type: this.getAttribute("type") || "" };
          if (current.tag !== expected.tag || (expected.id && current.id !== expected.id) || (expected.name && current.name !== expected.name) || (expected.type && current.type !== expected.type)) return { error: "stale" };
          if (this.disabled || this.getAttribute("aria-disabled") === "true") return { error: "disabled" };
          this.scrollIntoView({ block: "center", inline: "center", behavior: "instant" });
          const style = getComputedStyle(this);
          const rect = this.getBoundingClientRect();
          if (style.display === "none" || style.visibility === "hidden" || rect.width <= 0 || rect.height <= 0) return { error: "hidden" };
          const previous = window.__pbcAgentCursorPosition;
          return {
            x: rect.left + rect.width / 2,
            y: rect.top + rect.height / 2,
            startX: previous && Number.isFinite(previous.x) ? previous.x : persisted && Number.isFinite(persisted.x) ? persisted.x : innerWidth * .5,
            startY: previous && Number.isFinite(previous.y) ? previous.y : persisted && Number.isFinite(persisted.y) ? persisted.y : innerHeight * .45
          };
        }`,
        arguments: [{ value: { tag: expected.tag, id: expected.id, name: expected.name, type: expected.type } }, { value: persisted }],
        returnByValue: true,
      });
      const state = inspected?.result?.value || {};
      if (state.error) throw new Error(`Upload button is ${state.error}. Run a fresh snapshot and retry.`);

      await send("Runtime.evaluate", { expression: `(${showAgentCursorInPage.toString()})(${state.startX}, ${state.startY})`, returnByValue: true });
      for (const point of curvedMousePath(state.startX, state.startY, state.x, state.y)) {
        await send("Input.dispatchMouseEvent", { type: "mouseMoved", x: point.x, y: point.y });
        await sleep(9 + Math.floor(Math.random() * 8));
      }

      const chooserOpened = waitForEvent("Page.fileChooserOpened", timeoutMs);
      await send("Input.dispatchMouseEvent", { type: "mousePressed", x: state.x, y: state.y, button: "left", clickCount: 1 });
      await send("Input.dispatchMouseEvent", { type: "mouseReleased", x: state.x, y: state.y, button: "left", clickCount: 1 });
      writeAgentCursorState(target.port, state.x, state.y);
      const chooser = await chooserOpened;
      if (!chooser?.backendNodeId) throw new Error("The page opened a file chooser, but CDP did not expose its file input.");
      if (files.length > 1 && chooser.mode !== "selectMultiple") {
        throw new Error("The file chooser does not support multiple files; pass exactly one file path.");
      }
      await send("DOM.setFileInputFiles", { files, backendNodeId: chooser.backendNodeId });
      return { mode: chooser.mode || "selectSingle" };
    } finally {
      await send("Page.setInterceptFileChooserDialog", { enabled: false }).catch(() => {});
    }
  });
}

function showAgentCursorInPage(x, y) {
  const cursorId = "__pbc-agent-cursor";
  let cursor = document.getElementById(cursorId);
  let created = false;
  if (!cursor) {
    created = true;
    cursor = document.createElement("div");
    cursor.id = cursorId;
    cursor.setAttribute("aria-hidden", "true");
    Object.assign(cursor.style, {
      position: "fixed",
      left: "0px",
      top: "0px",
      width: "22px",
      height: "28px",
      zIndex: "2147483647",
      pointerEvents: "none",
      opacity: "1",
      transform: "translate3d(var(--pbc-x, 0px), var(--pbc-y, 0px), 0)",
      transition: "transform 180ms cubic-bezier(.2,.8,.2,1), opacity 120ms ease",
      filter: "drop-shadow(0 2px 3px rgba(0,0,0,.45))",
    });
    cursor.innerHTML = `<svg width="22" height="28" viewBox="0 0 22 28" xmlns="http://www.w3.org/2000/svg"><path d="M2 1.5V22l5.7-5.1 4 8.7 4-1.9-4-8.4H20L2 1.5Z" fill="#2f81f7" stroke="white" stroke-width="1.7" stroke-linejoin="round"/></svg>`;
    cursor.style.setProperty("--pbc-x", `${x}px`);
    cursor.style.setProperty("--pbc-y", `${y}px`);
    const style = document.createElement("style");
    style.id = "__pbc-agent-cursor-style";
    style.textContent = `
      @keyframes pbc-agent-click { 0% { box-shadow: 0 0 0 0 rgba(47,129,247,.8); } 100% { box-shadow: 0 0 0 22px rgba(47,129,247,0); } }
      #__pbc-agent-cursor::before { content: "PBC"; position: absolute; left: 17px; top: 17px; padding: 2px 5px; border-radius: 5px; background: #2f81f7; color: white; font: 700 10px/1.2 system-ui, sans-serif; letter-spacing: .04em; white-space: nowrap; box-shadow: 0 1px 3px rgba(0,0,0,.35); }
      #__pbc-agent-cursor::after { content: ""; position: absolute; left: -7px; top: -7px; width: 16px; height: 16px; border-radius: 50%; }
      #__pbc-agent-cursor[data-clicking="true"]::after { animation: pbc-agent-click 420ms ease-out; }
    `;
    document.documentElement.append(style, cursor);
  }
  const previous = window.__pbcAgentCursorPosition;
  if (previous && Number.isFinite(previous.x) && Number.isFinite(previous.y)) {
    cursor.style.setProperty("--pbc-x", `${previous.x}px`);
    cursor.style.setProperty("--pbc-y", `${previous.y}px`);
  }
  cursor.style.opacity = "1";
  cursor.dataset.clicking = "false";
  if (!created) {
    cursor.style.setProperty("--pbc-x", `${x}px`);
    cursor.style.setProperty("--pbc-y", `${y}px`);
  }
  window.__pbcAgentCursorPosition = { x, y };
  if (!window.__pbcAgentCursorMouseListener) {
    window.__pbcAgentCursorMouseListener = (event) => {
      const activeCursor = document.getElementById(cursorId);
      if (!activeCursor) return;
      activeCursor.style.setProperty("--pbc-x", `${event.clientX}px`);
      activeCursor.style.setProperty("--pbc-y", `${event.clientY}px`);
      activeCursor.style.opacity = "1";
      window.__pbcAgentCursorPosition = { x: event.clientX, y: event.clientY };
    };
    addEventListener("mousemove", window.__pbcAgentCursorMouseListener, true);
  }
  if (!window.__pbcAgentCursorVisibilityListener) {
    window.__pbcAgentCursorVisibilityListener = () => {
      const activeCursor = document.getElementById(cursorId);
      if (activeCursor) activeCursor.style.display = document.visibilityState === "visible" ? "block" : "none";
    };
    addEventListener("visibilitychange", window.__pbcAgentCursorVisibilityListener, true);
  }
  cursor.style.display = document.visibilityState === "visible" ? "block" : "none";
  return true;
}

function curvedMousePath(startX, startY, endX, endY) {
  const dx = endX - startX;
  const dy = endY - startY;
  const distance = Math.hypot(dx, dy);
  const steps = Math.max(14, Math.min(48, Math.ceil(distance / 18)));
  const side = Math.random() < 0.5 ? -1 : 1;
  const bend = side * Math.min(130, Math.max(28, distance * (0.16 + Math.random() * 0.16)));
  const length = distance || 1;
  const controlX = (startX + endX) / 2 + (-dy / length) * bend;
  const controlY = (startY + endY) / 2 + (dx / length) * bend;
  const points = [];
  for (let index = 1; index <= steps; index += 1) {
    const t = index / steps;
    const eased = t < 0.5 ? 2 * t * t : 1 - Math.pow(-2 * t + 2, 2) / 2;
    const inverse = 1 - eased;
    points.push({
      x: inverse * inverse * startX + 2 * inverse * eased * controlX + eased * eased * endX,
      y: inverse * inverse * startY + 2 * inverse * eased * controlY + eased * eased * endY,
    });
  }
  return points;
}

async function moveAgentCursorToLocator(page, locator, port) {
  await page.bringToFront().catch(() => {});
  const cursorTimeout = actionTimeoutMs();
  const scroll = await locator.evaluate((node) => {
    const rect = node.getBoundingClientRect();
    const needsScroll = rect.top < 8 || rect.left < 8 || rect.bottom > innerHeight - 8 || rect.right > innerWidth - 8;
    if (needsScroll) node.scrollIntoView({ block: "center", inline: "center", behavior: "auto" });
    return { needsScroll };
  }, undefined, { timeout: cursorTimeout }).catch(() => ({ needsScroll: false }));
  if (scroll.needsScroll) await sleep(420);
  const box = await locator.boundingBox({ timeout: cursorTimeout }).catch(() => null);
  if (!box) return null;
  const endX = box.x + box.width / 2;
  const endY = box.y + box.height / 2;
  const start = await page.evaluate(({ source, endX, endY }) => {
    const previous = window.__pbcAgentCursorPosition;
    const startX = previous && Number.isFinite(previous.x) ? previous.x : Math.max(18, Math.min(innerWidth - 18, innerWidth * .5));
    const startY = previous && Number.isFinite(previous.y) ? previous.y : Math.max(18, Math.min(innerHeight - 18, innerHeight * .45));
    const show = new Function(`return (${source})`)();
    show(startX, startY);
    return { startX, startY, endX, endY };
  }, { source: showAgentCursorInPage.toString(), endX, endY });
  for (const point of curvedMousePath(start.startX, start.startY, endX, endY)) {
    await page.mouse.move(point.x, point.y);
    await sleep(9 + Math.floor(Math.random() * 8));
  }
  if (Number.isFinite(port)) writeAgentCursorState(port, endX, endY);
  // Install the cursor re-injection script at most ONCE per page. It used to be added on
  // every click, which grows the page's init-script list without bound and re-runs all of
  // them on each navigation (see playwright-mcp #1636 advice on unbounded accumulation in
  // long-lived CDP sessions). showAgentCursorInPage() re-reads window.__pbcAgentCursorPosition
  // itself, so a single registration stays correct as the cursor moves.
  if (!page.__pbcCursorInitScriptAdded) {
    page.__pbcCursorInitScriptAdded = true;
    await page.addInitScript({
      content: `(() => {
        const install = () => (${showAgentCursorInPage.toString()})(${JSON.stringify(endX)}, ${JSON.stringify(endY)});
        if (document.documentElement) install(); else addEventListener("DOMContentLoaded", install, { once: true });
      })()`,
    }).catch(() => {});
  }
  return { x: endX, y: endY };
}

async function directPageClickRef(target, expected, options = {}) {
  const button = options.button === "right" ? "right" : "left";
  await fetch(`http://127.0.0.1:${target.port}/json/activate/${target.targetId}`).catch(() => {});
  const persisted = readAgentCursorState(target.port);
  return withDirectPageSession(target, async (send, waitForEvent) => {
    await send("Page.enable");
    const evaluation = await send("Runtime.evaluate", {
      expression: `document.evaluate(${JSON.stringify(expected.selector)}, document, null, XPathResult.FIRST_ORDERED_NODE_TYPE, null).singleNodeValue`,
      returnByValue: false,
    });
    const objectId = evaluation?.result?.objectId;
    if (!objectId) return { error: "missing" };

    const initialResult = await send("Runtime.callFunctionOn", {
      objectId,
      functionDeclaration: `function (expected, persisted) {
        const current = { tag: this.tagName.toLowerCase(), id: this.id || "", name: this.getAttribute("name") || "", type: this.getAttribute("type") || "" };
        if (current.tag !== expected.tag || (expected.id && current.id !== expected.id) || (expected.name && current.name !== expected.name) || (expected.type && current.type !== expected.type)) return { error: "stale", current };
        if (this.disabled || this.getAttribute("aria-disabled") === "true") return { error: "disabled" };
        const before = this.getBoundingClientRect();
        const needsScroll = before.top < 8 || before.left < 8 || before.bottom > innerHeight - 8 || before.right > innerWidth - 8;
        if (needsScroll) this.scrollIntoView({ block: "center", inline: "center", behavior: "smooth" });
        const previous = window.__pbcAgentCursorPosition;
        return {
          needsScroll,
          startX: previous && Number.isFinite(previous.x) ? previous.x : persisted && Number.isFinite(persisted.x) ? Math.max(8, Math.min(innerWidth - 8, persisted.x)) : Math.max(18, Math.min(innerWidth - 18, innerWidth * .5)),
          startY: previous && Number.isFinite(previous.y) ? previous.y : persisted && Number.isFinite(persisted.y) ? Math.max(8, Math.min(innerHeight - 8, persisted.y)) : Math.max(18, Math.min(innerHeight - 18, innerHeight * .45))
        };
      }`,
      arguments: [{ value: { tag: expected.tag, id: expected.id, name: expected.name, type: expected.type } }, { value: persisted }],
      returnByValue: true,
    });
    const initial = initialResult?.result?.value || {};
    if (initial.error) return initial;
    if (initial.needsScroll) await sleep(420);

    const stateResult = await send("Runtime.callFunctionOn", {
      objectId,
      functionDeclaration: `function () {
        const style = getComputedStyle(this);
        const rect = this.getBoundingClientRect();
        if (style.display === "none" || style.visibility === "hidden" || rect.width <= 0 || rect.height <= 0) return { error: "hidden" };
        return { x: rect.left + rect.width / 2, y: rect.top + rect.height / 2 };
      }`,
      returnByValue: true,
    });
    const state = stateResult?.result?.value || {};
    if (state.error) return state;

    await send("Runtime.evaluate", {
      expression: `(${showAgentCursorInPage.toString()})(${JSON.stringify(initial.startX)}, ${JSON.stringify(initial.startY)})`,
      returnByValue: true,
    });
    const path = curvedMousePath(initial.startX, initial.startY, state.x, state.y);
    for (const point of path) {
      await send("Input.dispatchMouseEvent", { type: "mouseMoved", x: point.x, y: point.y });
      await sleep(9 + Math.floor(Math.random() * 8));
    }
    await send("Runtime.evaluate", {
      expression: `(() => { const cursor = document.getElementById("__pbc-agent-cursor"); if (cursor) { cursor.dataset.clicking = "false"; void cursor.offsetWidth; cursor.dataset.clicking = "true"; } })()`,
      returnByValue: true,
    });
    const preloadSource = `(() => {
      const install = () => (${showAgentCursorInPage.toString()})(${JSON.stringify(state.x)}, ${JSON.stringify(state.y)});
      if (document.documentElement) install(); else addEventListener("DOMContentLoaded", install, { once: true });
    })()`;
    await send("Page.addScriptToEvaluateOnNewDocument", { source: preloadSource });
    const navigationStarted = waitForEvent("Page.frameStartedLoading", 650).catch(() => null);
    await send("Input.dispatchMouseEvent", { type: "mousePressed", x: state.x, y: state.y, button, clickCount: 1 });
    await send("Input.dispatchMouseEvent", { type: "mouseReleased", x: state.x, y: state.y, button, clickCount: 1 });
    writeAgentCursorState(target.port, state.x, state.y);
    if (await navigationStarted) {
      await waitForEvent("Page.loadEventFired", 8000).catch(() => null);
      await sleep(150);
    }
    return { clicked: true };
  });
}

async function directPageDragRefs(target, sourceExpected, destinationExpected) {
  await fetch(`http://127.0.0.1:${target.port}/json/activate/${target.targetId}`).catch(() => {});
  const persisted = readAgentCursorState(target.port);
  return withDirectPageSession(target, async (send) => {
    const resolveNode = async (expected) => {
      const evaluation = await send("Runtime.evaluate", {
        expression: `document.evaluate(${JSON.stringify(expected.selector)}, document, null, XPathResult.FIRST_ORDERED_NODE_TYPE, null).singleNodeValue`,
        returnByValue: false,
      });
      return evaluation?.result?.objectId || "";
    };
    const sourceId = await resolveNode(sourceExpected);
    const destinationId = await resolveNode(destinationExpected);
    if (!sourceId || !destinationId) return { error: "missing" };

    const inspectNode = async (objectId, expected, scroll) => {
      const result = await send("Runtime.callFunctionOn", {
        objectId,
        functionDeclaration: `function (expected, scroll) {
          const current = { tag: this.tagName.toLowerCase(), id: this.id || "", name: this.getAttribute("name") || "", type: this.getAttribute("type") || "" };
          if (current.tag !== expected.tag || (expected.id && current.id !== expected.id) || (expected.name && current.name !== expected.name) || (expected.type && current.type !== expected.type)) return { error: "stale" };
          if (this.disabled || this.getAttribute("aria-disabled") === "true") return { error: "disabled" };
          if (scroll) this.scrollIntoView({ block: "center", inline: "center", behavior: "smooth" });
          const style = getComputedStyle(this);
          const rect = this.getBoundingClientRect();
          if (style.display === "none" || style.visibility === "hidden" || rect.width <= 0 || rect.height <= 0) return { error: "hidden" };
          return { x: rect.left + rect.width / 2, y: rect.top + rect.height / 2, inViewport: rect.bottom > 0 && rect.right > 0 && rect.top < innerHeight && rect.left < innerWidth, width: innerWidth, height: innerHeight };
        }`,
        arguments: [{ value: { tag: expected.tag, id: expected.id, name: expected.name, type: expected.type } }, { value: scroll }],
        returnByValue: true,
      });
      return result?.result?.value || {};
    };

    await inspectNode(sourceId, sourceExpected, true);
    await sleep(420);
    let source = await inspectNode(sourceId, sourceExpected, false);
    let destination = await inspectNode(destinationId, destinationExpected, false);
    if (!destination.inViewport) {
      await inspectNode(destinationId, destinationExpected, true);
      await sleep(420);
      source = await inspectNode(sourceId, sourceExpected, false);
      destination = await inspectNode(destinationId, destinationExpected, false);
    }
    if (source.error || destination.error) return { error: source.error || destination.error };
    if (!source.inViewport || !destination.inViewport) return { error: "source-and-destination-not-simultaneously-visible" };

    const startX = persisted && Number.isFinite(persisted.x) ? Math.max(8, Math.min(source.width - 8, persisted.x)) : source.width * .5;
    const startY = persisted && Number.isFinite(persisted.y) ? Math.max(8, Math.min(source.height - 8, persisted.y)) : source.height * .45;
    await send("Runtime.evaluate", { expression: `(${showAgentCursorInPage.toString()})(${startX}, ${startY})`, returnByValue: true });
    for (const point of curvedMousePath(startX, startY, source.x, source.y)) {
      await send("Input.dispatchMouseEvent", { type: "mouseMoved", x: point.x, y: point.y });
      await sleep(9 + Math.floor(Math.random() * 8));
    }
    await send("Input.dispatchMouseEvent", { type: "mousePressed", x: source.x, y: source.y, button: "left", clickCount: 1 });
    await sleep(90 + Math.floor(Math.random() * 80));
    for (const point of curvedMousePath(source.x, source.y, destination.x, destination.y)) {
      await send("Input.dispatchMouseEvent", { type: "mouseMoved", x: point.x, y: point.y, button: "left", buttons: 1 });
      await sleep(11 + Math.floor(Math.random() * 9));
    }
    await send("Input.dispatchMouseEvent", { type: "mouseReleased", x: destination.x, y: destination.y, button: "left", clickCount: 1 });
    writeAgentCursorState(target.port, destination.x, destination.y);
    return { dragged: true };
  });
}

function collectSnapshotItemsInPage() {
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

  function getXPath(node) {
    const segments = [];
    for (let current = node; current && current.nodeType === Node.ELEMENT_NODE; current = current.parentElement) {
      let index = 1;
      for (let sibling = current.previousElementSibling; sibling; sibling = sibling.previousElementSibling) {
        if (sibling.tagName === current.tagName) index += 1;
      }
      segments.unshift(`${current.tagName.toLowerCase()}[${index}]`);
    }
    return `/${segments.join("/")}`;
  }

  return Array.from(document.querySelectorAll(selector))
    .filter((node) => {
      const style = window.getComputedStyle(node);
      const rect = node.getBoundingClientRect();
      return style.visibility !== "hidden" && style.display !== "none" && rect.width > 0 && rect.height > 0;
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
      return {
        ref: `e${index}`,
        selector: getXPath(node),
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
}

async function snapshotTab(port, token, options = {}) {
  if (!options.frame) {
    const tabs = await listDirectPageTargets(port);
    const tab = resolveTab(tabs, token);
    const result = await directPageEvaluate(
      tab,
      `({items: (${collectSnapshotItemsInPage.toString()})(), title: document.title, url: location.href})`
    );
    const items = result?.items || [];
    persistTabRefs(tab.id, result?.url || tab.url, items);
    const publicItems = items.map(({ selector, ...item }) => item);
    return {
      tab: { id: tab.id, url: result?.url || tab.url, title: result?.title || tab.title },
      frame: { name: "", url: result?.url || tab.url },
      items: publicItems,
    };
  }

  return withResolvedTab(port, token, async (tab) => {
    const frame = await resolveFrame(tab.page, options.frame);
    if (!frame) throw new Error(`Could not find a frame matching "${options.frame}".`);

    const items = await frame.evaluate(collectSnapshotItemsInPage);

    persistTabRefs(tab.id, frame.url(), items);

    const publicItems = items.map(({ selector, ...item }) => item);

    return {
      tab: { id: tab.id, url: tab.page.url(), title: await tab.page.title().catch(() => tab.title) },
      frame: { name: frame.name() || "", url: frame.url() },
      items: publicItems,
    };
  });
}

function collectTextInPage(opts = {}) {
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
}

async function textTab(port, token, options = {}) {
  const includeValues = Boolean(options.includeValues);
  if (!options.frame) {
    const tabs = await listDirectPageTargets(port);
    const tab = resolveTab(tabs, token);
    const result = await directPageEvaluate(
      tab,
      `({text: (${collectTextInPage.toString()})(${JSON.stringify({ includeValues })}), title: document.title, url: location.href})`
    );
    return {
      tab: { id: tab.id, url: result?.url || tab.url, title: result?.title || tab.title },
      frame: { name: "", url: result?.url || tab.url },
      text: result?.text || "",
    };
  }

  return withResolvedTab(port, token, async (tab) => {
    const frame = await resolveFrame(tab.page, options.frame);
    if (!frame) throw new Error(`Could not find a frame matching "${options.frame}".`);

    const text = await frame.evaluate(collectTextInPage, { includeValues });

    return {
      tab: { id: tab.id, url: tab.page.url(), title: await tab.page.title().catch(() => tab.title) },
      frame: { name: frame.name() || "", url: frame.url() },
      text,
    };
  });
}

async function clickTab(port, token, target, options = {}) {
  const raw = String(target || "").trim();
  if (!raw) throw new Error("Click target is required.");
  const button = options.button === "right" ? "right" : "left";

  if (!options.frame && /^e\d+$/i.test(raw)) {
    const tabs = await listDirectPageTargets(port);
    const tab = resolveTab(tabs, token);
    const expected = lookupRefSignature(tab.id, tab.url, raw.toLowerCase());
    if (!expected?.selector) {
      throw new Error(`Ref ${raw.toLowerCase()} is not available. Run 'pbc tab snapshot' again and use a fresh ref.`);
    }
    const result = await directPageClickRef(tab, expected, { button });
    if (result?.error) {
      throw new Error(`Cannot click ref ${raw.toLowerCase()}: ${result.error}. Run 'pbc tab snapshot' again and use a fresh ref.`);
    }
    return { clicked: raw, mode: "ref-direct", url: tab.url };
  }

  return withResolvedTab(port, token, async (tab) => {
    await ensureUsableViewport(tab.page);

    const frame = await resolveFrame(tab.page, options.frame);
    if (!frame) throw new Error(`Could not find a frame matching "${options.frame}".`);

    const { locator, mode } = await resolveTargetLocator(frame, raw, {
      tabId: tab.id,
      frameUrl: frame.url(),
      kind: "click",
    });
    await moveAgentCursorToLocator(tab.page, locator, port);
    await clickLocatorFastFail(locator, { timeoutMs: options.timeoutMs, button });

    return { clicked: raw, mode, button, url: tab.page.url() };
  });
}

async function dragTab(port, token, sourceRef, destinationRef) {
  const source = String(sourceRef || "").trim().toLowerCase();
  const destination = String(destinationRef || "").trim().toLowerCase();
  if (!/^e\d+$/.test(source) || !/^e\d+$/.test(destination)) {
    throw new Error("Drag currently requires two fresh snapshot refs, for example: pbc tab drag active e12 e19");
  }
  const tabs = await listDirectPageTargets(port);
  const tab = resolveTab(tabs, token);
  const sourceExpected = lookupRefSignature(tab.id, tab.url, source);
  const destinationExpected = lookupRefSignature(tab.id, tab.url, destination);
  if (!sourceExpected?.selector || !destinationExpected?.selector) {
    throw new Error("One or both drag refs are unavailable. Run 'pbc tab snapshot' again and use fresh refs.");
  }
  const result = await directPageDragRefs(tab, sourceExpected, destinationExpected);
  if (result?.error) {
    throw new Error(`Cannot drag ${source} to ${destination}: ${result.error}. Run 'pbc tab snapshot' again and use fresh refs.`);
  }
  return { source, destination, mode: "ref-direct", url: tab.url };
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
    await moveAgentCursorToLocator(tab.page, locator, port);
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
    await moveAgentCursorToLocator(tab.page, locator, port);

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

function normalizeUploadFiles(filePaths) {
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
  return files;
}

async function uploadTab(port, token, target, filePaths, options = {}) {
  const raw = String(target || "").trim();
  if (!raw) throw new Error("Upload target is required.");
  const files = normalizeUploadFiles(filePaths);

  if (!options.frame) {
    const tabs = await listDirectPageTargets(port);
    const tab = resolveTab(tabs, token);
    let mode = "selector-direct";
    let expression;

    if (/^e\d+$/i.test(raw)) {
      mode = "ref-direct";
      const expected = lookupRefSignature(tab.id, tab.url, raw.toLowerCase());
      if (!expected?.selector) {
        throw new Error(`Ref ${raw.toLowerCase()} is not available. Run 'pbc tab snapshot' again and use a fresh ref.`);
      }
      if (expected.tag !== "input" || String(expected.type || "").toLowerCase() !== "file") {
        await directPageUploadThroughChooser(tab, expected, files, actionTimeoutMs(options));
        return { uploaded: raw, mode: "ref-file-chooser-direct", files, url: tab.url };
      }
      expression = `(() => {
        const expected = ${JSON.stringify({ tag: expected.tag, id: expected.id, name: expected.name, type: expected.type })};
        const node = document.evaluate(${JSON.stringify(expected.selector)}, document, null, XPathResult.FIRST_ORDERED_NODE_TYPE, null).singleNodeValue;
        if (!node) throw new Error("Upload ref is no longer in the page. Run a fresh snapshot.");
        const current = { tag: node.tagName.toLowerCase(), id: node.id || "", name: node.getAttribute("name") || "", type: node.getAttribute("type") || "" };
        if (current.tag !== expected.tag || (expected.id && current.id !== expected.id) || (expected.name && current.name !== expected.name) || (expected.type && current.type !== expected.type)) {
          throw new Error("Upload ref is stale. Run a fresh snapshot.");
        }
        return current.tag === "input" && current.type === "file" ? node : node.querySelector?.('input[type="file"]');
      })()`;
    } else {
      expression = `(() => {
        const raw = ${JSON.stringify(raw)};
        let node = null;
        try { node = document.querySelector(raw); } catch {}
        if (node && !(node.matches && node.matches('input[type="file"]'))) node = node.querySelector?.('input[type="file"]') || null;
        if (node) return node;
        const needle = raw.trim().toLowerCase();
        for (const input of document.querySelectorAll('input[type="file"]')) {
          const label = input.id ? document.querySelector('label[for="' + CSS.escape(input.id) + '"]') : null;
          const haystack = [input.getAttribute("aria-label"), input.getAttribute("name"), label?.textContent, input.closest("label")?.textContent, input.parentElement?.textContent]
            .filter(Boolean).join(" ").replace(/\s+/g, " ").trim().toLowerCase();
          if (needle && haystack.includes(needle)) return input;
        }
        return null;
      })()`;
    }

    await directPageSetFileInputFiles(tab, expression, files);
    return { uploaded: raw, mode, files, url: tab.url };
  }

  return withResolvedTab(port, token, async (tab) => {
    await ensureUsableViewport(tab.page);

    const frame = await resolveFrame(tab.page, options.frame);
    if (!frame) throw new Error(`Could not find a frame matching "${options.frame}".`);

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
  const tabs = await listDirectPageTargets(port);
  const tab = resolveTab(tabs, token);
  const image = await withDirectPageSession(tab, async (send) => {
    const params = {
      format: "png",
      fromSurface: true,
      captureBeyondViewport: Boolean(options.fullPage),
    };
    if (options.fullPage) {
      const metrics = await send("Page.getLayoutMetrics");
      const size = metrics?.cssContentSize || metrics?.contentSize;
      if (size?.width > 0 && size?.height > 0) {
        params.clip = { x: 0, y: 0, width: size.width, height: size.height, scale: 1 };
      }
    }
    return send("Page.captureScreenshot", params);
  });
  if (!image?.data) throw new Error("Chrome did not return screenshot data.");
  fs.mkdirSync(path.dirname(outputPath), { recursive: true });
  fs.writeFileSync(outputPath, Buffer.from(image.data, "base64"));
  return { path: outputPath, url: tab.url };
}

async function evalTab(port, token, source, options = {}) {
  if (!options.frame) {
    const tabs = await listDirectPageTargets(port);
    const tab = resolveTab(tabs, token);
    const expression = `(async () => {
      const script = ${JSON.stringify(source)};
      const AsyncFunction = Object.getPrototypeOf(async function () {}).constructor;
      let lastError;
      for (const body of ["return (" + script + ");", script]) {
        try {
          const value = await new AsyncFunction(body)();
          return { value, url: location.href, title: document.title };
        } catch (error) {
          lastError = error;
        }
      }
      if (lastError instanceof SyntaxError) {
        throw new Error("tab eval: inline JavaScript did not compile in the page. If you passed quotes inside the script from cmd.exe/PowerShell, the shell may have mangled them - use --base64 <b64> or --file <path> instead. Detail: " + (lastError && lastError.message));
      }
      throw lastError;
    })()`;
    const result = await directPageEvaluate(tab, expression);
    return {
      tab: { id: tab.id, url: result?.url || tab.url, title: result?.title || tab.title },
      frame: { name: "", url: result?.url || tab.url },
      value: result?.value,
    };
  }

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

// Create a tab through the browser-level CDP endpoint. Like /json/close this is
// served by the browser process, so it still works when a renderer is wedged.
async function createCdpTarget(port, url) {
  const response = await fetch(`http://127.0.0.1:${port}/json/version`);
  if (!response.ok) throw new Error(`Could not read CDP version endpoint on port ${port}.`);
  const data = await response.json();
  if (!data.webSocketDebuggerUrl) throw new Error(`CDP websocket URL is missing on port ${port}.`);
  return new Promise((resolve, reject) => {
    let settled = false;
    const ws = new WebSocket(data.webSocketDebuggerUrl);
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      try { ws.close(); } catch {}
      reject(new Error("Timed out while requesting Target.createTarget."));
    }, cdpTimeoutMs());
    ws.addEventListener("open", () => {
      ws.send(JSON.stringify({ id: 1, method: "Target.createTarget", params: { url } }));
    });
    ws.addEventListener("message", (event) => {
      if (settled) return;
      let message;
      try { message = JSON.parse(String(event.data || "{}")); } catch { return; }
      if (message.id !== 1) return;
      settled = true;
      clearTimeout(timer);
      try { ws.close(); } catch {}
      if (message.error) reject(new Error(message.error.message || "Target.createTarget failed."));
      else resolve(message.result || {});
    });
    ws.addEventListener("error", () => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      reject(new Error("CDP connection failed while creating the target."));
    });
  });
}

// Close a tab that has stopped answering page-level CDP using the browser-level
// HTTP endpoint. This works even when the renderer main thread is blocked, which is
// the one recovery path that does not require killing Chrome.
async function unstickTab(port, token, options = {}) {
  const raw = String(token == null ? "active" : token).trim() || "active";
  const response = await fetch(`http://127.0.0.1:${port}/json/list`).catch(() => null);
  if (!response || !response.ok) throw new Error(`CDP /json/list not reachable on port ${port}.`);
  const pages = (await response.json().catch(() => [])).filter((target) => target.type === "page");
  if (!pages.length) return { matched: false, closed: false, reasons: "no page targets" };

  let target = null;
  if (/^active$/i.test(raw)) {
    target = pages[0];
  } else if (/^\d+$/.test(raw)) {
    target = pages[Number(raw)] || null;
  } else {
    const needle = raw.toLowerCase();
    target =
      pages.find((page) => `${page.url || ""} ${page.title || ""}`.toLowerCase().includes(needle)) || null;
  }
  if (!target) return { matched: false, closed: false, token: raw };

  const url = target.url || "";
  const title = target.title || "";
  const closeResponse = await fetch(`http://127.0.0.1:${port}/json/close/${target.id}`).catch(() => null);
  const closed = Boolean(closeResponse && closeResponse.ok);

  let reopen = null;
  if (closed && options.reopen && url) {
    try {
      const created = await createCdpTarget(port, url);
      const targetId = created?.targetId || "";
      let verified = false;
      for (let attempt = 0; attempt < 6 && !verified; attempt += 1) {
        await sleep(500);
        const check = await fetch(`http://127.0.0.1:${port}/json/list`).catch(() => null);
        if (!check || !check.ok) break;
        const list = await check.json().catch(() => []);
        verified = list.some((target) => target.type === "page" && target.id === targetId);
      }
      reopen = { ok: Boolean(targetId) && verified, url, targetId };
      if (!reopen.ok) {
        reopen.error = `Target.createTarget returned ${targetId || "no target id"} but no matching tab was listed afterwards.`;
      }
    } catch (error) {
      reopen = { ok: false, error: error.message || String(error) };
    }
  }
  return { matched: true, closed, id: target.id, url, title, reopen };
}

// Largest resident (WorkingSet) size among this profile's renderers, in MB. WorkingSet is
// resident memory, which matters: the retracted playwright-mcp #1636 report was virtual-only.
function largestRendererWorkingSetMb() {
  if (process.platform !== "win32") return 0;
  const fsMod = require("node:fs");
  const osMod = require("node:os");
  const pathMod = require("node:path");
  const tmp = pathMod.join(osMod.tmpdir(), `pbc-mem-${process.pid}.ps1`);
  const script = [
    `$marker = '${USER_DATA_DIR}'`,
    `$procs = Get-CimInstance Win32_Process -Filter "Name='chrome.exe'" | Where-Object { $_.CommandLine -match [regex]::Escape($marker) -and $_.CommandLine -match '--type=renderer' }`,
    `($procs | Measure-Object -Property WorkingSetSize -Maximum).Maximum`,
  ].join("\r\n");
  try {
    fsMod.writeFileSync(tmp, script, "utf8");
    const { execSync } = require("node:child_process");
    const out = execSync(`powershell -NoProfile -ExecutionPolicy Bypass -File "${tmp}"`, {
      encoding: "utf8",
      windowsHide: true,
      timeout: 15000,
    });
    const bytes = Number(String(out).trim());
    return Number.isFinite(bytes) && bytes > 0 ? Math.round(bytes / 1048576) : 0;
  } catch {
    return 0;
  } finally {
    try { fsMod.unlinkSync(tmp); } catch {}
  }
}

// Non-destructive mitigation for the renderer bloat that precedes a CDP wedge. Chrome gives
// no way to cancel runaway JS, but Memory.simulatePressureNotification makes the renderer
// collect garbage and drop caches, and HeapProfiler.collectGarbage forces a full GC. This is
// the "apply pressure / recycle instead of killing the tab" half of the advice in
// microsoft/playwright #15400 and playwright-mcp #1636 - it costs no page state.
async function deflateTab(port, token) {
  const tabs = await listDirectPageTargets(port);
  const tab = resolveTab(tabs, token);
  if (!tab) throw new Error(`No page target matched "${token}".`);
  const beforeMb = largestRendererWorkingSetMb();
  const outcome = await withDirectPageSession(tab, async (send) => {
    const pressure = await send("Memory.simulatePressureNotification", { level: "critical" })
      .then(() => true)
      .catch(() => false);
    const gc = await send("HeapProfiler.collectGarbage")
      .then(() => true)
      .catch(() => false);
    return { pressure, gc };
  });
  await sleep(1500);
  const afterMb = largestRendererWorkingSetMb();
  return {
    id: tab.id,
    url: tab.url,
    title: tab.title,
    pressureNotification: outcome.pressure,
    forcedGc: outcome.gc,
    largestRendererMbBefore: beforeMb,
    largestRendererMbAfter: afterMb,
    freedMb: Math.max(0, beforeMb - afterMb),
  };
}

// Move the human-like cursor onto a target WITHOUT clicking anything, and optionally
// outline it so a screenshot can prove which element was selected before a real click.
// Use this to verify a risky target (Save, Submit, Delete) first.
async function hoverTab(port, token, target, options = {}) {
  const raw = String(target || "").trim();
  if (!raw) throw new Error("Hover target is required.");
  return withResolvedTab(port, token, async (tab) => {
    const frame = await resolveFrame(tab.page, options.frame);
    if (!frame) throw new Error(`Could not find a frame matching "${options.frame}".`);
    // Resolve exactly like a click would, so what you verify is what would be clicked.
    const { locator, mode } = await resolveTargetLocator(frame, raw, {
      tabId: tab.id,
      frameUrl: frame.url(),
      kind: "click",
    });
    const state = await elementState(locator);
    if (!state) {
      throw new Error(
        `Hover target ${JSON.stringify(raw)} was not found (mode=${mode}). Nothing was moved or clicked.`
      );
    }
    const cursor = await moveAgentCursorToLocator(tab.page, locator, port);
    let outlined = false;
    if (options.highlight !== false) {
      const ms = Number(options.highlightMs) > 0 ? Number(options.highlightMs) : 6000;
      outlined = await locator
        .evaluate((node, highlightMs) => {
          const previousOutline = node.style && node.style.outline;
          const previousOffset = node.style && node.style.outlineOffset;
          node.style.outline = "3px solid #2f81f7";
          node.style.outlineOffset = "2px";
          setTimeout(() => {
            if (!node.style) return;
            node.style.outline = previousOutline || "";
            node.style.outlineOffset = previousOffset || "";
          }, highlightMs);
          return true;
        }, ms)
        .catch(() => false);
    }
    return {
      tab: { id: tab.id, url: tab.page.url(), title: await tab.page.title().catch(() => tab.title) },
      frame: { name: frame.name() || "", url: frame.url() },
      target: raw,
      mode,
      element: describeState(state),
      outlined,
      cursor: cursor ? { x: Math.round(cursor.x), y: Math.round(cursor.y) } : null,
      clicked: false,
    };
  });
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

function killOversizedRenderers(thresholdGb = 2, profileMarker = USER_DATA_DIR) {
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
    await disconnectBrowser(connection.browser).catch(() => {});
  }
}

module.exports = {
  activateTab,
  clickTab,
  dragTab,
  closeTab,
  deflateTab,
  evalTab,
  fillTab,
  listCdpTargets,
  healStalledTabs,
  pressKey,
  gotoTab,
  hoverTab,
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
  unstickTab,
  uploadTab,
  downloadTab,
  pdfTab,
  reuseOrOpenTab,
  resolveFrame,
  withResolvedTab,
};
