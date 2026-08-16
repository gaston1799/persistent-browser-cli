const tls = require("node:tls");
const { resolveFrame, withResolvedTab } = require("./tab_tools");

const RISK_PATTERNS = [
  { pattern: /s3\.us-east-2\.amazonaws\.com\/saoletto\/.*\.html/i, reason: "Known JavaScript-stub download path" },
  { pattern: /(?:trk\.)?sparkrainstorm\.host/i, reason: "Known affiliate-tracker domain" },
  { pattern: /(?:mydownloadsitecenter|dropfluxy|ythestarsarequ)\.com/i, reason: "Known deceptive-download domain" },
  { pattern: /(?:bstlar|loot-link|lootdest)\.com/i, reason: "Known monetized link-wall domain" },
  { pattern: /setup[_ -]?(?:is[_ -]?)?ready.*\.exe/i, reason: "Generic downloader filename pattern" },
];

function looksLikeSelector(value) {
  return /^[.#\[]/.test(value) || /^(input|textarea|select|button|a|label|form|div|span)\b/i.test(value) || /^\/\//.test(value);
}

function redactHeaders(headers) {
  const sensitive = new Set(["authorization", "cookie", "set-cookie", "proxy-authorization"]);
  return Object.fromEntries(Object.entries(headers || {}).filter(([key]) => !sensitive.has(String(key).toLowerCase())));
}

function classifySignals(url, text, hrefs = []) {
  const haystack = `${url}\n${text}\n${hrefs.join("\n")}`;
  const reasons = RISK_PATTERNS.filter((entry) => entry.pattern.test(haystack)).map((entry) => entry.reason);
  if (/download extension|install extension|your file is ready|setup file/i.test(text)) reasons.push("Page text matches deceptive-download bait");
  if (/unlock progress|complete .*task|like\s*(?:&|and)\s*comment/i.test(text)) reasons.push("Page appears to be a task or link wall");
  const pupFlag = /download extension|install extension|add to chrome|setup[_ -]?(?:is[_ -]?)?ready/i.test(haystack);
  const wallFlag = /unlock progress|complete .*task|like\s*(?:&|and)\s*comment/i.test(text) || /(?:bstlar|loot-link|lootdest)\.com/i.test(url);
  const scamFlag = reasons.some((reason) => /stub|affiliate|deceptive|filename/i.test(reason));
  const verdict = scamFlag ? "scam" : wallFlag ? "wall" : reasons.length ? "unknown" : "real";
  const fileName = (haystack.match(/(?:setup[_ -]?(?:is[_ -]?)?ready[^\s"'<]*\.exe|[\w.-]+\.(?:exe|msi|zip))/i) || [])[0] || null;
  return {
    verdict,
    reasons: [...new Set(reasons)],
    pupFlag,
    fileName,
    suggestedAction: verdict === "scam" ? "Do not download or execute anything. Record the URL and use a trusted source." : verdict === "wall" ? "Do not attempt to bypass the wall UNLESS its the only way to get to the destination. Look for an official mirror or source." : "Verify any downloaded file before opening it.",
  };
}

async function classifyTab(port, token) {
  return withResolvedTab(port, token, async (tab) => {
    const pageData = await tab.page.evaluate(() => ({
      text: (document.body?.innerText || document.documentElement?.textContent || "").slice(0, 30000),
      hrefs: Array.from(document.querySelectorAll("a[href]")).slice(0, 300).map((node) => node.href),
    }));
    return { tab: { id: tab.id, url: tab.page.url(), title: await tab.page.title().catch(() => tab.title) }, ...classifySignals(tab.page.url(), pageData.text, pageData.hrefs) };
  });
}

async function stateTab(port, token, options = {}) {
  return withResolvedTab(port, token, async (tab) => {
    const result = await tab.page.evaluate((rawPattern) => {
      let matcher;
      try { matcher = new RegExp(rawPattern, "i"); } catch { matcher = /progress|task|unlock|complete|step|verify/i; }
      const summarize = (value) => value == null || ["string", "number", "boolean"].includes(typeof value) ? value : Array.isArray(value) ? { type: "array", length: value.length } : typeof value === "object" ? { type: "object", keys: Object.keys(value).slice(0, 30) } : { type: typeof value };
      const components = [];
      for (const node of Array.from(document.querySelectorAll("*")).slice(0, 5000)) {
        const frameworkKeys = Object.keys(node).filter((key) => key.startsWith("__vue") || key.startsWith("__reactFiber$") || key.startsWith("__reactProps$"));
        if (!frameworkKeys.length) continue;
        const vue = node.__vue__ || node.__vueParentComponent?.proxy || node.__vue_app__?._instance?.proxy;
        const matchingKeys = vue && typeof vue === "object" ? Object.keys(vue).filter((key) => matcher.test(key)).slice(0, 40) : [];
        if (matchingKeys.length || frameworkKeys.some((key) => key.startsWith("__react"))) components.push({ tag: node.tagName.toLowerCase(), id: node.id || "", framework: vue ? "vue" : "react", matchingKeys, values: Object.fromEntries(matchingKeys.map((key) => [key, summarize(vue[key])])) });
        if (components.length >= 60) break;
      }
      return { components, localStorageKeys: Object.keys(localStorage), sessionStorageKeys: Object.keys(sessionStorage), cookieNames: document.cookie.split(";").map((part) => part.trim().split("=")[0]).filter(Boolean) };
    }, String(options.keys || "progress|task|unlock|complete|step|verify"));
    return { tab: { id: tab.id, url: tab.page.url(), title: await tab.page.title().catch(() => tab.title) }, ...result };
  });
}

async function unhideTab(port, token) {
  return withResolvedTab(port, token, async (tab) => {
    const result = await tab.page.evaluate(() => {
      const overlaysNeutralized = [];
      for (const node of Array.from(document.querySelectorAll("body *"))) {
        const style = getComputedStyle(node);
        const rect = node.getBoundingClientRect();
        const zIndex = Number.parseInt(style.zIndex || "0", 10) || 0;
        if (rect.width >= innerWidth * 0.8 && rect.height >= innerHeight * 0.8 && (Number(style.opacity || "1") < 0.05 || style.backgroundColor === "transparent") && zIndex >= 10 && style.pointerEvents !== "none") {
          node.style.pointerEvents = "none";
          overlaysNeutralized.push({ tag: node.tagName.toLowerCase(), id: node.id || "", className: String(node.className || "").slice(0, 120) });
        }
      }
      for (const dialog of Array.from(document.querySelectorAll("dialog[open]"))) dialog.close?.();
      return { overlaysNeutralized, note: "Disabled controls were not enabled." };
    });
    return { tab: { id: tab.id, url: tab.page.url() }, ...result };
  });
}

async function watchNetwork(port, token, action = "log") {
  return withResolvedTab(port, token, async (tab) => {
    const result = await tab.page.evaluate((mode) => {
      const sanitize = (headers) => Object.fromEntries(Object.entries(headers || {}).filter(([key]) => !/^(authorization|cookie|set-cookie|proxy-authorization)$/i.test(key)));
      if (mode === "clear") { window.__pbcNetLog = []; return { cleared: true }; }
      if (mode === "install" && !window.__pbcNetWatchInstalled) {
        window.__pbcNetLog = window.__pbcNetLog || [];
        const push = (entry) => window.__pbcNetLog.push({ at: new Date().toISOString(), ...entry });
        const originalFetch = window.fetch;
        window.fetch = async function (...args) { const request = args[0]; const init = args[1] || {}; const url = typeof request === "string" ? request : request?.url || ""; const method = init.method || request?.method || "GET"; try { const response = await originalFetch.apply(this, args); push({ kind: "fetch", method, url, status: response.status, responseHeaders: sanitize(Object.fromEntries(response.headers.entries())) }); return response; } catch (error) { push({ kind: "fetch", method, url, error: String(error?.message || error) }); throw error; } };
        const originalOpen = XMLHttpRequest.prototype.open;
        const originalSend = XMLHttpRequest.prototype.send;
        XMLHttpRequest.prototype.open = function (method, url, ...rest) { this.__pbcNet = { method, url }; return originalOpen.call(this, method, url, ...rest); };
        XMLHttpRequest.prototype.send = function (...args) { this.addEventListener("loadend", () => push({ kind: "xhr", method: this.__pbcNet?.method || "GET", url: this.__pbcNet?.url || "", status: this.status })); return originalSend.apply(this, args); };
        window.__pbcNetWatchInstalled = true;
      }
      return { installed: Boolean(window.__pbcNetWatchInstalled), entries: (window.__pbcNetLog || []).slice(-200) };
    }, action);
    return { tab: { id: tab.id, url: tab.page.url() }, ...result };
  });
}

async function grepJsTab(port, token, pattern, options = {}) {
  return withResolvedTab(port, token, async (tab) => {
    let matcher;
    try { matcher = new RegExp(pattern, "ig"); } catch { throw new Error(`Invalid JavaScript pattern: ${pattern}`); }
    const urls = await tab.page.evaluate(() => [...new Set([...Array.from(document.scripts).map((script) => script.src).filter(Boolean), ...performance.getEntriesByType("resource").map((entry) => entry.name).filter((url) => /\.m?js(?:[?#]|$)/i.test(url))])].slice(0, 80));
    const matches = [];
    for (const url of urls) {
      const source = await tab.page.evaluate(async (resourceUrl) => { try { const response = await fetch(resourceUrl, { credentials: "same-origin" }); return response.ok ? await response.text() : ""; } catch { return ""; } }, url);
      let match;
      while (source && (match = matcher.exec(source)) && matches.length < 100) { matches.push({ url, match: match[0], context: source.slice(Math.max(0, match.index - 200), Math.min(source.length, match.index + match[0].length + 200)) }); if (!match[0]) matcher.lastIndex += 1; }
      matcher.lastIndex = 0;
      if (matches.length >= 100) break;
    }
    return { tab: { id: tab.id, url: tab.page.url() }, scanned: urls.length, matches, ...(options.chunks ? { chunks: urls } : {}) };
  });
}

async function waitUntilTab(port, token, target, options = {}) {
  return withResolvedTab(port, token, async (tab) => {
    const frame = await resolveFrame(tab.page, options.frame);
    if (!frame) throw new Error(`Could not find a frame matching "${options.frame}".`);
    const timeout = Math.min(Math.max(Number(options.timeout) || 30000, 250), 120000);

    if (options.regex) {
      let matcher;
      try {
        matcher = new RegExp(options.regex);
      } catch (error) {
        throw new Error(`Invalid --regex pattern: ${error.message}`);
      }
      await tab.page.waitForFunction(
        (pattern) => new RegExp(pattern).test((document.body?.innerText || document.documentElement?.textContent || "")),
        String(options.regex),
        { timeout }
      );
      return {
        tab: { id: tab.id, url: tab.page.url() },
        target,
        regex: String(options.regex),
        enabled: Boolean(options.enabled),
        timeout,
      };
    }

    const locator = looksLikeSelector(target) ? frame.locator(target).first() : frame.getByText(target, { exact: false }).first();
    await locator.waitFor({ state: "visible", timeout });
    if (options.enabled) {
      const handle = await locator.elementHandle();
      try {
        await tab.page.waitForFunction((node) => Boolean(node) && !node.disabled && node.getAttribute("aria-disabled") !== "true", handle, { timeout });
      } finally {
        await handle?.dispose().catch(() => {});
      }
    }
    return { tab: { id: tab.id, url: tab.page.url() }, target, enabled: Boolean(options.enabled), timeout };
  });
}

async function certificateTab(port, token) {
  return withResolvedTab(port, token, async (tab) => {
    const url = new URL(tab.page.url());
    if (url.protocol !== "https:") throw new Error("TLS certificate details are only available for HTTPS pages.");
    const certificate = await new Promise((resolve, reject) => { const socket = tls.connect({ host: url.hostname, port: Number(url.port) || 443, servername: url.hostname, rejectUnauthorized: false }, () => { const cert = socket.getPeerCertificate(true); socket.end(); resolve(cert); }); socket.setTimeout(10000, () => { socket.destroy(); reject(new Error("Timed out while reading the TLS certificate.")); }); socket.on("error", reject); });
    return { tab: { id: tab.id, url: tab.page.url() }, issuer: certificate.issuer, subject: certificate.subject, subjectaltname: certificate.subjectaltname || "", valid_from: certificate.valid_from, valid_to: certificate.valid_to, fingerprint256: certificate.fingerprint256 || "" };
  });
}

async function headersTab(port, token) {
  return withResolvedTab(port, token, async (tab) => {
    const result = await tab.page.evaluate(async () => { const request = async (method) => { const response = await fetch(location.href, { method, credentials: "same-origin", redirect: "manual" }); return { status: response.status, type: response.type, headers: Object.fromEntries(response.headers.entries()) }; }; try { return await request("HEAD"); } catch { return await request("GET"); } });
    return { tab: { id: tab.id, url: tab.page.url() }, status: result.status, type: result.type, headers: redactHeaders(result.headers) };
  });
}

module.exports = { classifySignals, classifyTab, stateTab, unhideTab, watchNetwork, grepJsTab, waitUntilTab, certificateTab, headersTab };
