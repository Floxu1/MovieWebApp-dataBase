import { createHash, randomUUID } from "node:crypto";
import { createReadStream, existsSync } from "node:fs";
import { createServer } from "node:http";
import { extname, join, normalize } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = fileURLToPath(new URL(".", import.meta.url));
const publicDir = join(__dirname, "public");

const config = {
  domain: process.env.MOVIEJAVAN_DOMAIN || "https://windowsapps.website",
  apiKey: process.env.MOVIEJAVAN_API_KEY || "1661e8b60126d9f9",
  userAgent: process.env.MOVIEJAVAN_USER_AGENT || "chrome88.0.0-mjagent"
};

const sessions = new Map();
const proxyLogs = [];
const maxProxyLogs = 500;
const playstorePathPrefixes = [
  "/movie",
  "/movies",
  "/series",
  "/episode",
  "/genre",
  "/actor",
  "/director",
  "/search",
  "/category",
  "/anime",
  "/kids",
  "/login",
  "/user",
  "/profile",
  "/subscription",
  "/ajax",
  "/home",
  "/filter",
  "/page",
  "/pages",
  "/post",
  "/posts",
  "/video",
  "/videos",
  "/download",
  "/link",
  "/links"
];

const contentTypes = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
  ".ico": "image/x-icon"
};

function apiUrl(pathname, params = {}) {
  const url = new URL(pathname, config.domain.replace(/\/+$/, ""));
  for (const [key, value] of Object.entries(params)) {
    if (value !== undefined && value !== null && value !== "") {
      url.searchParams.set(key, value);
    }
  }
  return url;
}

function apiSecretUrl(pathname, params = {}) {
  return apiUrl(pathname, { api_secret_key: config.apiKey, ...params });
}

function json(res, status, body) {
  const payload = JSON.stringify(body);
  res.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Content-Length": Buffer.byteLength(payload)
  });
  res.end(payload);
}

function addLog(type, details = {}) {
  proxyLogs.push({
    time: new Date().toISOString(),
    type,
    ...details
  });
  if (proxyLogs.length > maxProxyLogs) proxyLogs.splice(0, proxyLogs.length - maxProxyLogs);
}

function decodeBase64Url(value) {
  try {
    const normalized = decodeURIComponent(value || "").replace(/-/g, "+").replace(/_/g, "/");
    const padded = normalized.padEnd(Math.ceil(normalized.length / 4) * 4, "=");
    return Buffer.from(padded, "base64").toString("utf8");
  } catch {
    return "";
  }
}

function parseCookies(header = "") {
  return Object.fromEntries(
    header
      .split(";")
      .map((part) => part.trim())
      .filter(Boolean)
      .map((part) => {
        const index = part.indexOf("=");
        return index === -1 ? [part, ""] : [part.slice(0, index), decodeURIComponent(part.slice(index + 1))];
      })
  );
}

function getSession(req, res) {
  const cookies = parseCookies(req.headers.cookie);
  let sid = cookies.mj_sid;
  if (!sid || !sessions.has(sid)) {
    sid = randomUUID();
    sessions.set(sid, {
      domain: config.domain,
      upstreamCookies: new Map(),
      credentials: null,
      user: null
    });
    res.setHeader("Set-Cookie", `mj_sid=${encodeURIComponent(sid)}; Path=/; HttpOnly; SameSite=Lax`);
  }
  return sessions.get(sid);
}

function storeUpstreamCookies(session, setCookieHeader) {
  const values = Array.isArray(setCookieHeader) ? setCookieHeader : setCookieHeader ? [setCookieHeader] : [];
  for (const cookie of values) {
    const pair = cookie.split(";")[0];
    const index = pair.indexOf("=");
    if (index > 0) {
      session.upstreamCookies.set(pair.slice(0, index), pair.slice(index + 1));
    }
  }
}

function upstreamCookieHeader(session) {
  return [...session.upstreamCookies.entries()].map(([key, value]) => `${key}=${value}`).join("; ");
}

function isPlaystorePath(pathname) {
  return playstorePathPrefixes.some((prefix) => pathname === prefix || pathname.startsWith(`${prefix}/`));
}

function toUpstreamPlaystorePath(pathname) {
  if (!pathname || pathname === "/") return "/playstore/";
  if (pathname === "/playstore" || pathname.startsWith("/playstore/")) return pathname;
  if (isPlaystorePath(pathname)) return `/playstore${pathname}`;
  return pathname;
}

function toLocalAppPath(pathname) {
  return `/app${toUpstreamPlaystorePath(pathname)}`;
}

async function readJson(req) {
  const chunks = [];
  for await (const chunk of req) chunks.push(chunk);
  if (!chunks.length) return {};
  return JSON.parse(Buffer.concat(chunks).toString("utf8"));
}

async function upstream(url, options = {}) {
  const response = await fetch(url, {
    ...options,
    headers: {
      "user-agent": config.userAgent,
      "cache-control": "no-cache",
      ...(options.headers || {})
    }
  });

  const text = await response.text();
  if (!response.ok) {
    throw new Error(`Upstream ${response.status}: ${text.slice(0, 180)}`);
  }

  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}

function publicProxyUrl(targetUrl, baseDomain) {
  if (
    !targetUrl ||
    targetUrl.startsWith("#") ||
    targetUrl.startsWith("mailto:") ||
    targetUrl.startsWith("tel:") ||
    targetUrl.startsWith("javascript:")
  ) {
    return targetUrl;
  }

  try {
    const absolute = new URL(targetUrl, baseDomain);
    if (absolute.pathname === "/player") {
      return `/player${absolute.search}${absolute.hash}`;
    }

    if (absolute.searchParams.get("type") === "vlc" || absolute.searchParams.get("type") === "idm") {
      return `/player?target=${encodeURIComponent(absolute.toString())}`;
    }

    if (absolute.protocol !== "http:" && absolute.protocol !== "https:") {
      return targetUrl;
    }

    if (absolute.pathname.startsWith("/app/")) {
      return `${absolute.pathname}${absolute.search}${absolute.hash}`;
    }

    return `${toLocalAppPath(absolute.pathname)}${absolute.search}${absolute.hash}`;
  } catch {
    return targetUrl;
  }
}

function rewriteTextUrls(text, upstreamUrl) {
  const baseDomain = upstreamUrl.toString();
  return text
    .replace(/\s(href|src|action)=["']([^"']+)["']/gi, (match, attr, value) => {
      return ` ${attr}="${publicProxyUrl(value, baseDomain)}"`;
    })
    .replace(/\s(data-url|data-href|data-link|data-src|data-lazy|poster)=["']([^"']+)["']/gi, (match, attr, value) => {
      return ` ${attr}="${publicProxyUrl(value, baseDomain)}"`;
    })
    .replace(/\s(srcset)=["']([^"']+)["']/gi, (match, attr, value) => {
      const rewrittenSrcset = value
        .split(",")
        .map((entry) => {
          const parts = entry.trim().split(/\s+/);
          if (!parts[0]) return entry;
          parts[0] = publicProxyUrl(parts[0], baseDomain);
          return parts.join(" ");
        })
        .join(", ");
      return ` ${attr}="${rewrittenSrcset}"`;
    })
    .replace(/url\((['"]?)([^'")]+)\1\)/g, (match, quote, value) => {
      return `url("${publicProxyUrl(value, baseDomain)}")`;
    })
    .replace(/(["'])(https?:\/\/[^"']+)\1/gi, (match, quote, value) => {
      return `${quote}${publicProxyUrl(value, baseDomain)}${quote}`;
    })
    .replace(/(["'])\/(playstore\/)?(movie|movies|series|episode|genre|actor|director|search|category|anime|kids|login|user|profile|subscription|ajax|home|filter|page|pages|post|posts|video|videos|download|link|links)(\/[^"']*)?\1/gi, (match, quote, maybePlaystore, first, rest = "") => {
      return `${quote}${publicProxyUrl(`/${maybePlaystore || ""}${first}${rest}`, baseDomain)}${quote}`;
    });
}

function rewriteCssUrls(css, upstreamUrl) {
  const baseDomain = upstreamUrl.toString();
  return css.replace(/url\((['"]?)([^'")]+)\1\)/g, (match, quote, value) => {
    return `url("${publicProxyUrl(value, baseDomain)}")`;
  });
}

function rewriteHtml(html, upstreamUrl) {
  const scripts = [];
  let rewritten = html.replace(/<script\b[\s\S]*?<\/script>/gi, (script) => {
    if (/\ssrc\s*=/i.test(script)) {
      return rewriteTextUrls(script, upstreamUrl);
    }
    const index = scripts.push(script) - 1;
    return `<!--__MJ_SCRIPT_${index}__-->`;
  });

  rewritten = rewriteTextUrls(rewritten, upstreamUrl);
  rewritten = rewritten.replace(/<!--__MJ_SCRIPT_(\d+)__-->/g, (match, index) => {
    return scripts[Number(index)] || match;
  });

  const helper = `
<script>
(() => {
  if (window.__movieJavanProxyInstalled) return;
  window.__movieJavanProxyInstalled = true;
  const passthroughProtocols = new Set(["mailto:", "tel:", "javascript:", "data:", "blob:"]);
  const rewriteAttributes = ["href", "src", "action", "data-url", "data-href", "data-link", "data-src", "data-lazy", "poster"];
  const emitLog = (payload) => {
    try {
      navigator.sendBeacon("/api/client-log", new Blob([JSON.stringify(payload)], { type: "application/json" }));
    } catch {
      try {
        fetch("/api/client-log", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify(payload),
          keepalive: true
        });
      } catch {}
    }
  };
  const convert = (value) => {
    try {
      if (!value || typeof value !== "string" || value.startsWith("#")) return value;
      const url = new URL(value, location.href);
      if (passthroughProtocols.has(url.protocol)) return value;
      if (url.origin === location.origin && url.pathname === "/player") {
        return url.pathname + url.search + url.hash;
      }
      if (url.searchParams.get("type") === "vlc" || url.searchParams.get("type") === "idm") {
        return "/player?target=" + encodeURIComponent(url.href.replace(location.origin + "/app", "${upstreamUrl.origin}"));
      }
      const playstorePrefixes = ${JSON.stringify(playstorePathPrefixes)};
      const isPlaystorePath = (pathname) => playstorePrefixes.some((prefix) => pathname === prefix || pathname.startsWith(prefix + "/"));
      const toUpstreamPlaystorePath = (pathname) => {
        if (!pathname || pathname === "/") return "/playstore/";
        if (pathname === "/playstore" || pathname.startsWith("/playstore/")) return pathname;
        if (isPlaystorePath(pathname)) return "/playstore" + pathname;
        return pathname;
      };
      if (url.origin === location.origin && url.pathname.startsWith("/app/")) return value;
      return "/app" + toUpstreamPlaystorePath(url.pathname) + url.search + url.hash;
    } catch { return value; }
  };
  const rewriteElement = (element) => {
    if (!element || !element.getAttribute) return;
    for (const attr of rewriteAttributes) {
      const value = element.getAttribute(attr);
      if (!value) continue;
      const converted = convert(value);
      if (converted !== value) element.setAttribute(attr, converted);
    }
    const srcset = element.getAttribute("srcset");
    if (srcset) {
      const convertedSrcset = srcset.split(",").map((entry) => {
        const parts = entry.trim().split(/\\s+/);
        if (parts[0]) parts[0] = convert(parts[0]);
        return parts.join(" ");
      }).join(", ");
      if (convertedSrcset !== srcset) element.setAttribute("srcset", convertedSrcset);
    }
  };
  const rewriteTree = (root) => {
    rewriteElement(root);
    if (root && root.querySelectorAll) root.querySelectorAll(rewriteAttributes.map((attr) => "[" + attr + "]").join(",") + ",[srcset]").forEach(rewriteElement);
  };
  const nativePushState = history.pushState.bind(history);
  const nativeReplaceState = history.replaceState.bind(history);
  history.pushState = (state, title, url) => nativePushState(state, title, url ? convert(url) : url);
  history.replaceState = (state, title, url) => nativeReplaceState(state, title, url ? convert(url) : url);
  const nativeOpen = window.open.bind(window);
  window.open = (url, target, features) => nativeOpen(url ? convert(url) : url, target, features);
  const nativeFetch = window.fetch ? window.fetch.bind(window) : null;
  if (nativeFetch) {
    window.fetch = (resource, options) => {
      if (typeof resource === "string") {
        const converted = convert(resource);
        emitLog({ kind: "fetch", from: resource, to: converted, page: location.href });
        return nativeFetch(converted, options);
      }
      if (resource && resource.url) {
        const converted = convert(resource.url);
        emitLog({ kind: "fetch-request", from: resource.url, to: converted, page: location.href });
        return nativeFetch(new Request(converted, resource), options);
      }
      return nativeFetch(resource, options);
    };
  }
  const nativeOpenXhr = XMLHttpRequest.prototype.open;
  XMLHttpRequest.prototype.open = function(method, url, ...rest) {
    const converted = convert(url);
    emitLog({ kind: "xhr", method, from: url, to: converted, page: location.href });
    return nativeOpenXhr.call(this, method, converted, ...rest);
  };
  const nativeSetAttribute = Element.prototype.setAttribute;
  Element.prototype.setAttribute = function(name, value) {
    return nativeSetAttribute.call(this, name, rewriteAttributes.includes(String(name).toLowerCase()) ? convert(value) : value);
  };
  document.addEventListener("click", (event) => {
    const target = event.target.closest && event.target.closest("a[href], button, [role='button'], [data-url], [data-href], [data-link], [onclick]");
    if (!target) return;
    rewriteElement(target);
    const candidate = target.getAttribute("data-url") || target.getAttribute("data-href") || target.getAttribute("data-link");
    emitLog({
      kind: "click",
      tag: target.tagName,
      text: (target.innerText || target.textContent || "").trim().slice(0, 120),
      href: target.getAttribute("href"),
      dataUrl: target.getAttribute("data-url"),
      dataHref: target.getAttribute("data-href"),
      dataLink: target.getAttribute("data-link"),
      page: location.href
    });
    if (candidate && (candidate.includes("type=vlc") || candidate.includes("type=idm"))) {
      event.preventDefault();
      location.href = convert(candidate);
    }
  }, true);
  document.addEventListener("submit", (event) => {
    const form = event.target;
    if (form && form.getAttribute) rewriteElement(form);
  }, true);
  const observer = new MutationObserver((mutations) => {
    for (const mutation of mutations) {
      if (mutation.type === "attributes") rewriteElement(mutation.target);
      for (const node of mutation.addedNodes) {
        if (node.nodeType === 1) rewriteTree(node);
      }
    }
  });
  let loadMoreTimer = 0;
  const contentContainer = () => document.querySelector("#listmovies") || document.querySelector("#section-opt");
  const contentCount = () => contentContainer()?.children.length || 0;
  const isNearPageEnd = () => {
    const doc = document.documentElement;
    const body = document.body;
    const scrollTop = window.scrollY || doc.scrollTop || body?.scrollTop || 0;
    const viewportHeight = window.innerHeight || doc.clientHeight || 0;
    const pageHeight = Math.max(doc.scrollHeight || 0, body?.scrollHeight || 0);
    return pageHeight > viewportHeight && pageHeight - (scrollTop + viewportHeight) < 420;
  };
  const runLoadMoreFallback = (reason) => {
    if (loadMoreTimer) clearTimeout(loadMoreTimer);
    const countBefore = contentCount();
    loadMoreTimer = setTimeout(() => {
      loadMoreTimer = 0;
      if (!isNearPageEnd() || contentCount() > countBefore || window.active === 1) return;
      const loader = document.getElementById("loader-line");
      try {
        if (document.querySelector("#section-opt") && typeof window.add_movies === "function" && window.featuregenremovies) {
          window.active = 1;
          if (typeof window.page === "number") window.page += 1;
          if (loader?.style) loader.style.zIndex = "1000";
          window.add_movies();
        } else if (document.querySelector("#section-opt") && typeof window.add_movies === "function" && typeof window.get_movies === "function") {
          window.active = 0;
          window.get_movies();
          setTimeout(() => runLoadMoreFallback("data-ready-" + reason), 700);
          return;
        } else if (typeof window.get_movies === "function") {
          window.active = 1;
          if (typeof window.page === "number") window.page += 1;
          if (loader?.style) loader.style.zIndex = "1000";
          window.get_movies();
        } else {
          return;
        }
        rewriteTree(contentContainer());
        emitLog({ kind: "load-more-fallback", reason, before: countBefore, after: contentCount(), page: location.href });
      } catch (error) {
        window.active = 0;
        if (loader?.style) loader.style.zIndex = "-1";
        emitLog({ kind: "load-more-fallback-error", reason, message: error.message, page: location.href });
      }
    }, 260);
  };
  window.addEventListener("scroll", () => runLoadMoreFallback("scroll"), { passive: true });
  window.addEventListener("wheel", () => runLoadMoreFallback("wheel"), { passive: true });
  window.addEventListener("touchmove", () => runLoadMoreFallback("touchmove"), { passive: true });
  window.addEventListener("keydown", (event) => {
    if (["End", "PageDown", "ArrowDown", " "].includes(event.key)) runLoadMoreFallback("keydown");
  }, true);
  const start = () => {
    rewriteTree(document.documentElement);
    observer.observe(document.documentElement, {
      childList: true,
      subtree: true,
      attributes: true,
      attributeFilter: rewriteAttributes.concat(["srcset"])
    });
  };
  if (document.documentElement) start();
  else document.addEventListener("DOMContentLoaded", start, { once: true });
})();
</script>`;

  if (rewritten.match(/<head[^>]*>/i)) {
    rewritten = rewritten.replace(/<head([^>]*)>/i, `<head$1>${helper}`);
  } else if (rewritten.includes("</body>")) {
    rewritten = rewritten.replace("</body>", `${helper}</body>`);
  } else {
    rewritten += helper;
  }
  return rewritten;
}

function playerPage(target) {
  let decoded = "";
  let title = "لینک پخش";
  try {
    const url = new URL(target);
    const pid = url.searchParams.get("pid");
    const direct = url.searchParams.get("url") || url.searchParams.get("link") || url.searchParams.get("file") || url.searchParams.get("src");
    const t = url.searchParams.get("t") || url.searchParams.get("title");
    decoded = pid ? decodeBase64Url(pid) : direct || target;
    title = t ? decodeURIComponent(t) : title;
  } catch {
    decoded = target || "";
  }

  return `<!doctype html>
<html lang="fa" dir="rtl">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>${title}</title>
  <style>
    body{margin:0;min-height:100vh;display:grid;place-items:center;background:#090b0f;color:#f2f5f8;font-family:Tahoma,Arial,sans-serif}
    main{width:min(720px,calc(100% - 32px));display:grid;gap:16px}
    a,button{min-height:44px;border-radius:8px;border:0;background:#e03131;color:#fff;padding:0 16px;text-decoration:none;display:inline-grid;place-items:center;cursor:pointer}
    input{width:100%;min-height:44px;border-radius:8px;border:1px solid #303846;background:#10141b;color:#fff;padding:0 12px;direction:ltr}
    .row{display:flex;gap:10px;flex-wrap:wrap}
  </style>
</head>
<body>
  <main>
    <h1>${title}</h1>
    <input value="${decoded.replace(/"/g, "&quot;")}" readonly />
    <div class="row">
      <a href="${decoded}" target="_blank" rel="noreferrer">باز کردن لینک</a>
      <button onclick="navigator.clipboard.writeText(document.querySelector('input').value)">کپی لینک</button>
    </div>
  </main>
</body>
</html>`;
}

function isPlayerRequest(url) {
  const type = url.searchParams.get("type");
  if (type === "vlc" || type === "idm") return true;

  const pid = url.searchParams.get("pid");
  if (pid && /^https?:\/\//i.test(decodeBase64Url(pid))) return true;

  for (const key of ["url", "link", "file", "src"]) {
    const value = url.searchParams.get(key);
    if (value && /^https?:\/\//i.test(value)) return true;
  }

  return false;
}

function sendPlayerPage(res, targetUrl) {
  const html = playerPage(targetUrl);
  res.writeHead(200, {
    "Content-Type": "text/html; charset=utf-8",
    "Content-Length": Buffer.byteLength(html)
  });
  res.end(html);
}

async function handleAppProxy(req, res, pathname, search) {
  const startedAt = Date.now();
  const session = getSession(req, res);
  const upstreamPath = toUpstreamPlaystorePath(pathname.replace(/^\/app/, "") || "/playstore/");
  const upstreamUrl = new URL(upstreamPath + search, session.domain || config.domain);

  if (isPlayerRequest(upstreamUrl)) {
    addLog("player", {
      local: `${pathname}${search}`,
      target: upstreamUrl.toString()
    });
    sendPlayerPage(res, upstreamUrl.toString());
    return;
  }

  let method = req.method;
  let body;
  const headers = {
    "user-agent": config.userAgent,
    "cache-control": "no-cache"
  };

  const cookieHeader = upstreamCookieHeader(session);
  if (cookieHeader) headers.cookie = cookieHeader;

  if (upstreamUrl.pathname.includes("do_login_windows") && session.credentials) {
    method = "POST";
    body = new URLSearchParams(session.credentials);
    headers["content-type"] = "application/x-www-form-urlencoded";
  } else if (req.method !== "GET" && req.method !== "HEAD") {
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    body = Buffer.concat(chunks);
    if (req.headers["content-type"]) headers["content-type"] = req.headers["content-type"];
  }

  const requestOptions = {
    method,
    headers,
    body,
    redirect: "manual"
  };

  let response = await fetch(upstreamUrl, requestOptions);
  let finalUpstreamUrl = upstreamUrl;
  let retryMode = "";
  const hasFileExtension = /\.[a-z0-9]{2,8}$/i.test(upstreamUrl.pathname);
  if (response.status === 404 && !upstreamUrl.pathname.startsWith("/playstore/") && !hasFileExtension) {
    const retryUrl = new URL(`/playstore${upstreamUrl.pathname}${search}`, session.domain || config.domain);
    response = await fetch(retryUrl, requestOptions);
    finalUpstreamUrl = retryUrl;
    retryMode = "add-playstore";
  } else if (response.status === 404 && upstreamUrl.pathname.startsWith("/playstore/") && !hasFileExtension) {
    const retryPath = upstreamUrl.pathname.replace(/^\/playstore/, "") || "/";
    const retryUrl = new URL(`${retryPath}${search}`, session.domain || config.domain);
    response = await fetch(retryUrl, requestOptions);
    finalUpstreamUrl = retryUrl;
    retryMode = "remove-playstore";
  }

  storeUpstreamCookies(session, response.headers.getSetCookie?.() || response.headers.get("set-cookie"));

  if ([301, 302, 303, 307, 308].includes(response.status)) {
    const location = response.headers.get("location");
    res.writeHead(response.status, {
      Location: publicProxyUrl(location, finalUpstreamUrl.toString())
    });
    res.end();
    return;
  }

  let contentType = response.headers.get("content-type") || "application/octet-stream";
  let buffer = Buffer.from(await response.arrayBuffer());
  const looksLikeJsonBody = () => {
    const sample = buffer.toString("utf8", 0, Math.min(buffer.length, 200)).trimStart();
    if (!sample.startsWith("{") && !sample.startsWith("[")) return false;
    try {
      JSON.parse(buffer.toString("utf8"));
      return true;
    } catch {
      return false;
    }
  };

  const bodyLooksLikeCustom404 = () => {
    if (!contentType.includes("text/html") || hasFileExtension) return false;
    const sample = buffer.toString("utf8", 0, Math.min(buffer.length, 5000));
    return /Look Like something wrong|page you were looking for is not here|>\s*404\s*</i.test(sample);
  };

  if (bodyLooksLikeCustom404() && finalUpstreamUrl.pathname.startsWith("/playstore/")) {
    const retryPath = finalUpstreamUrl.pathname.replace(/^\/playstore/, "") || "/";
    const retryUrl = new URL(`${retryPath}${search}`, session.domain || config.domain);
    const retryResponse = await fetch(retryUrl, requestOptions);
    const retryContentType = retryResponse.headers.get("content-type") || "application/octet-stream";
    const retryBuffer = Buffer.from(await retryResponse.arrayBuffer());
    const retrySample = retryBuffer.toString("utf8", 0, Math.min(retryBuffer.length, 5000));
    if (retryResponse.status < 400 && !/Look Like something wrong|page you were looking for is not here|>\s*404\s*</i.test(retrySample)) {
      response = retryResponse;
      finalUpstreamUrl = retryUrl;
      contentType = retryContentType;
      buffer = retryBuffer;
      retryMode = retryMode ? `${retryMode}+custom404-remove-playstore` : "custom404-remove-playstore";
    }
  }

  addLog("proxy", {
    method,
    local: `${pathname}${search}`,
    upstream: upstreamUrl.toString(),
    finalUpstream: finalUpstreamUrl.toString(),
    status: response.status,
    retryMode,
    contentType,
    bytes: buffer.length,
    ms: Date.now() - startedAt,
    referer: req.headers.referer || ""
  });

  const headersOut = {
    "Content-Type": contentType,
    "Cache-Control": "no-store"
  };

  if (looksLikeJsonBody()) {
    headersOut["Content-Type"] = "application/json; charset=utf-8";
    headersOut["Content-Length"] = buffer.length;
    res.writeHead(response.status, headersOut);
    res.end(buffer);
    return;
  }

  if (contentType.includes("text/html")) {
    const html = rewriteHtml(buffer.toString("utf8"), finalUpstreamUrl);
    headersOut["Content-Length"] = Buffer.byteLength(html);
    res.writeHead(response.status, headersOut);
    res.end(html);
    return;
  }

  if (/css/i.test(contentType)) {
    const text = rewriteCssUrls(buffer.toString("utf8"), finalUpstreamUrl);
    headersOut["Content-Length"] = Buffer.byteLength(text);
    res.writeHead(response.status, headersOut);
    res.end(text);
    return;
  }

  if (/json|javascript|ecmascript|text\/|xml/i.test(contentType)) {
    headersOut["Content-Length"] = buffer.length;
    res.writeHead(response.status, headersOut);
    res.end(buffer);
    return;
  }

  headersOut["Content-Length"] = buffer.length;
  res.writeHead(response.status, headersOut);
  res.end(buffer);
}

function md5(value) {
  return createHash("md5").update(value || "", "utf8").digest("hex");
}

function deviceId(value) {
  return value || `web-${randomUUID()}`;
}

async function handleApi(req, res, pathname) {
  if (req.method === "GET" && pathname === "/api/logs") {
    return json(res, 200, { logs: proxyLogs.slice().reverse() });
  }

  if (req.method === "POST" && pathname === "/api/logs/clear") {
    proxyLogs.length = 0;
    addLog("logs-cleared");
    return json(res, 200, { ok: true });
  }

  if (req.method === "POST" && pathname === "/api/client-log") {
    const body = await readJson(req);
    addLog("client", body);
    return json(res, 200, { ok: true });
  }

  if (req.method === "GET" && pathname === "/api/runtime") {
    getSession(req, res);
    return json(res, 200, {
      domain: config.domain,
      playstoreUrl: "/app/playstore/"
    });
  }

  if (req.method === "GET" && pathname === "/api/config") {
    getSession(req, res);
    const url = apiUrl("/playstore/rest-api/v100/windowsconfig", {
      "API-KEY": config.apiKey
    });
    return json(res, 200, await upstream(url));
  }

  if (req.method === "POST" && pathname === "/api/login") {
    const session = getSession(req, res);
    const body = await readJson(req);
    const url = apiUrl("/playstore/rest-api/v100/login_Data", {
      "API-KEY": config.apiKey,
      email: body.email,
      password: md5(body.password)
    });
    const user = await upstream(url);

    if (user?.status === "success") {
      session.credentials = {
        email: body.email || "",
        password: body.password || ""
      };
      session.user = user;
      const checkUrl = apiUrl("/playstore/pay_zarin/check_device.php", {
        "API-KEY": config.apiKey,
        userid: user.user_id,
        deviceid: deviceId(body.deviceId),
        devicemodel: body.deviceModel || "Web Browser",
        devicetype: "Web"
      });
      user.device = await upstream(checkUrl);

      if (user.substatus === "active") {
        try {
          const appConfig = await upstream(apiUrl("/playstore/rest-api/v100/windowsconfig", {
            "API-KEY": config.apiKey
          }));
          if (appConfig?.PaidUserDomain) session.domain = appConfig.PaidUserDomain;
        } catch {
          session.domain = config.domain;
        }
      } else {
        session.domain = config.domain;
      }
    }

    return json(res, 200, user);
  }

  if (req.method === "POST" && pathname === "/api/signup") {
    getSession(req, res);
    const body = await readJson(req);
    const form = new URLSearchParams({
      "API-KEY": config.apiKey,
      name: body.name || "",
      email: body.email || "",
      password: body.password || "",
      phone: body.phone || ""
    });
    const url = apiUrl("/playstore/rest-api/v100/signup_windows");
    return json(res, 200, await upstream(url, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: form
    }));
  }

  if (req.method === "POST" && pathname === "/api/forgot-password") {
    getSession(req, res);
    const body = await readJson(req);
    const url = apiSecretUrl("/playstore/api/password_reset", { email: body.email });
    return json(res, 200, await upstream(url));
  }

  if (req.method === "POST" && pathname === "/api/devices") {
    getSession(req, res);
    const body = await readJson(req);
    const url = apiSecretUrl("/playstore/api/get_device_by_user_id", { id: body.userId });
    return json(res, 200, await upstream(url));
  }

  if (req.method === "POST" && pathname === "/api/devices/deactivate") {
    getSession(req, res);
    const body = await readJson(req);
    const url = apiUrl("/playstore/pay_zarin/device_deactivate.php", {
      "API-KEY": config.apiKey,
      id: body.id,
      mode: body.mode || "id"
    });
    return json(res, 200, await upstream(url));
  }

  if (req.method === "POST" && pathname === "/api/devices/logout") {
    getSession(req, res);
    const body = await readJson(req);
    const url = apiUrl("/playstore/pay_zarin/device_logout.php", {
      "API-KEY": config.apiKey,
      id: body.userId,
      mode: "user"
    });
    return json(res, 200, await upstream(url));
  }

  return json(res, 404, { error: "API route not found" });
}

async function serveStatic(req, res, pathname) {
  const safePath = normalize(pathname === "/" ? "/index.html" : pathname).replace(/^(\.\.[/\\])+/, "");
  const filePath = join(publicDir, safePath);

  if (!filePath.startsWith(publicDir) || !existsSync(filePath)) {
    return false;
  }

  const ext = extname(filePath);
  const statHeaders = {
    "Content-Type": contentTypes[ext] || "application/octet-stream"
  };
  res.writeHead(200, statHeaders);
  createReadStream(filePath).pipe(res);
  return true;
}

const server = createServer(async (req, res) => {
  try {
    const url = new URL(req.url, "http://localhost");
    if (isPlayerRequest(url)) {
      sendPlayerPage(res, url.toString());
      return;
    }
    if (url.pathname === "/app/player") {
      res.writeHead(302, {
        Location: `/player${url.search}${url.hash}`
      });
      res.end();
      return;
    }
    if (url.pathname.startsWith("/api/")) {
      await handleApi(req, res, url.pathname);
      return;
    }
    if (url.pathname.startsWith("/app/")) {
      await handleAppProxy(req, res, url.pathname, url.search);
      return;
    }
    if (url.pathname === "/player") {
      const html = playerPage(url.searchParams.get("target") || "");
      res.writeHead(200, {
        "Content-Type": "text/html; charset=utf-8",
        "Content-Length": Buffer.byteLength(html)
      });
      res.end(html);
      return;
    }
    if (url.pathname === "/playstore" || url.pathname.startsWith("/playstore/") || isPlaystorePath(url.pathname)) {
      await handleAppProxy(req, res, `/app${url.pathname}`, url.search);
      return;
    }
    const served = await serveStatic(req, res, url.pathname);
    if (served) return;
    if (url.pathname !== "/" && !url.pathname.startsWith("/api/")) {
      await handleAppProxy(req, res, `/app${url.pathname}`, url.search);
      return;
    }
    res.writeHead(404, { "Content-Type": "text/plain; charset=utf-8" });
    res.end("Not found");
  } catch (error) {
    addLog("server-error", {
      url: req.url,
      message: error.message || "Internal server error",
      stack: error.stack ? error.stack.split("\n").slice(0, 4).join("\n") : ""
    });
    json(res, 500, { error: error.message || "Internal server error" });
  }
});

const port = Number(process.env.PORT || 4173);
server.listen(port, () => {
  console.log(`MovieJavan web is running on http://localhost:${port}`);
});
