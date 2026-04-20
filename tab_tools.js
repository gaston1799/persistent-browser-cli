const fs = require("node:fs");
const path = require("node:path");
const { chromium } = require("playwright-core");

function formatTabLabel(tab) {
  const marker = tab.active ? "*" : " ";
  const title = tab.title ? ` | ${tab.title}` : "";
  return `${marker} [${tab.id}] ${tab.url}${title}`;
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

async function connectPages(port) {
  const browser = await chromium.connectOverCDP(`http://127.0.0.1:${port}`);
  const tabs = [];
  let nextId = 0;

  for (const context of browser.contexts()) {
    for (const page of context.pages()) {
      const url = page.url();
      const title = await page.title().catch(() => "");
      const active = await page.evaluate(() => document.hasFocus()).catch(() => false);
      tabs.push({
        id: String(nextId),
        index: nextId,
        page,
        url,
        title,
        active,
      });
      nextId += 1;
    }
  }

  return { browser, tabs };
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

    const activeAny = tabs.find((tab) => tab.active);
    if (activeAny && !isInternalTab(activeAny)) return activeAny;

    const lastVisible = [...tabs].reverse().find((tab) => !isInternalTab(tab));
    if (lastVisible) return lastVisible;

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
  return withResolvedTab(port, token, async (tab) => {
    const result = { id: tab.id, url: tab.url, title: tab.title };
    await tab.page.close({ runBeforeUnload: false });
    return result;
  });
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

async function snapshotTab(port, token, options = {}) {
  return withResolvedTab(port, token, async (tab) => {
    const frame = await resolveFrame(tab.page, options.frame);
    if (!frame) throw new Error(`Could not find a frame matching "${options.frame}".`);

    const items = await frame.evaluate(() => {
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

    const text = await frame.evaluate(() => {
      const source = document.body?.innerText || document.documentElement?.textContent || "";
      return source.trim().replace(/\n{3,}/g, "\n\n");
    });

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

    if (/^e\d+$/i.test(raw)) {
      const ref = raw.toLowerCase();
      await frame.locator(`[data-pbc-ref="${ref}"]`).first().click();
      return { clicked: ref, mode: "ref", url: tab.page.url() };
    }

    if (looksLikeSelector(raw)) {
      await frame.locator(raw).first().click();
      return { clicked: raw, mode: "selector", url: tab.page.url() };
    }

    await frame.getByText(raw, { exact: false }).first().click();
    return { clicked: raw, mode: "text", url: tab.page.url() };
  });
}

async function fillLocator(locator, value) {
  try {
    await locator.fill(value);
    return "fill";
  } catch (error) {
    const tag = await locator.evaluate((node) => node.tagName.toLowerCase()).catch(() => "");
    if (tag !== "select") throw error;

    try {
      await locator.selectOption({ label: value });
      return "select-label";
    } catch {
      await locator.selectOption(value);
      return "select-value";
    }
  }
}

async function fillTab(port, token, target, value, options = {}) {
  return withResolvedTab(port, token, async (tab) => {
    await ensureUsableViewport(tab.page);

    const frame = await resolveFrame(tab.page, options.frame);
    if (!frame) throw new Error(`Could not find a frame matching "${options.frame}".`);

    const raw = String(target || "").trim();
    if (!raw) throw new Error("Fill target is required.");

    if (/^e\d+$/i.test(raw)) {
      const ref = raw.toLowerCase();
      const method = await fillLocator(frame.locator(`[data-pbc-ref="${ref}"]`).first(), value);
      return { filled: ref, mode: "ref", method, url: tab.page.url() };
    }

    if (looksLikeSelector(raw)) {
      const method = await fillLocator(frame.locator(raw).first(), value);
      return { filled: raw, mode: "selector", method, url: tab.page.url() };
    }

    try {
      const method = await fillLocator(frame.getByLabel(raw, { exact: false }).first(), value);
      return { filled: raw, mode: "label", method, url: tab.page.url() };
    } catch {
      const method = await fillLocator(frame.getByPlaceholder(raw, { exact: false }).first(), value);
      return { filled: raw, mode: "placeholder", method, url: tab.page.url() };
    }
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
      try {
        return await new AsyncFunction(`return (${script});`)();
      } catch {
        return await new AsyncFunction(script)();
      }
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
    if (String(error?.cause?.code || error?.code || "") === "ECONNREFUSED") {
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
      if (!sent) finish(new Error("Failed to connect to the CDP websocket."));
      else finish();
    });

    ws.addEventListener("close", () => {
      if (!sent) finish(new Error("CDP websocket closed before Browser.close was sent."));
      else finish();
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

module.exports = {
  activateTab,
  clickTab,
  closeTab,
  evalTab,
  fillTab,
  gotoTab,
  inspectFields,
  isInternalTab,
  listFrames,
  listTabs,
  pruneDuplicateTabs,
  saveAndCloseBrowser,
  screenshotTab,
  snapshotTab,
  textTab,
  reuseOrOpenTab,
};
