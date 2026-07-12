const http = require("http");
const fs = require("fs");
const path = require("path");

const PORT = Number(process.env.PORT) || 4174;
const ROOT = __dirname;
const UPSTREAM = "https://us-displays.burblesoft.com";
const sessions = new Map();
const MIME_TYPES = {
  ".css": "text/css; charset=utf-8",
  ".html": "text/html; charset=utf-8",
  ".ico": "image/x-icon",
  ".js": "application/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".png": "image/png",
  ".webmanifest": "application/manifest+json; charset=utf-8"
};

function send(res, status, body, headers = {}) {
  res.writeHead(status, { "Cache-Control": "no-store", ...headers });
  res.end(body);
}

function serveStatic(req, res) {
  const requestPath = new URL(req.url, `http://${req.headers.host}`).pathname;
  const relativePath = requestPath === "/" ? "index.html" : decodeURIComponent(requestPath.slice(1));
  const filePath = path.resolve(ROOT, relativePath);
  if (!filePath.startsWith(`${ROOT}${path.sep}`) && filePath !== path.join(ROOT, "index.html")) {
    send(res, 403, "Forbidden");
    return;
  }
  fs.readFile(filePath, (error, data) => {
    if (error) {
      send(res, error.code === "ENOENT" ? 404 : 500, error.code === "ENOENT" ? "Not found" : "Server error");
      return;
    }
    const type = MIME_TYPES[path.extname(filePath).toLowerCase()] || "application/octet-stream";
    res.writeHead(200, { "Content-Type": type, "Cache-Control": "no-cache" });
    res.end(data);
  });
}

function updateCookie(dzId, headers) {
  const values = typeof headers.getSetCookie === "function"
    ? headers.getSetCookie()
    : [headers.get("set-cookie")].filter(Boolean);
  for (const value of values) {
    const match = value.match(/(?:^|,\s*)(burblesoft=[^;,\s]+)/i);
    if (match) sessions.set(dzId, match[1]);
  }
}

async function requestUpstream(dzId, target, options) {
  let url = target;
  let method = options.method;
  let body = options.body;
  for (let redirects = 0; redirects < 10; redirects += 1) {
    const headers = { ...options.headers };
    const cookie = sessions.get(dzId);
    if (cookie) headers.cookie = cookie;
    const response = await fetch(url, { method, headers, body, redirect: "manual" });
    updateCookie(dzId, response.headers);
    if (![301, 302, 303, 307, 308].includes(response.status)) return response;
    const location = response.headers.get("location");
    if (!location) return response;
    url = new URL(location, url).href;
    if (response.status === 303 || ((response.status === 301 || response.status === 302) && method === "POST")) {
      method = "GET";
      body = undefined;
      delete options.headers["content-length"];
      delete options.headers["content-type"];
    }
  }
  throw new Error("Too many Burble redirects");
}

function rewriteText(text, dzId) {
  const prefix = `/burble/${dzId}/`;
  return text
    .replace(/https:\/\/us-displays\.burblesoft\.com(?::443)?\//gi, prefix)
    .replace(/https:\/\/dzm\.burblesoft\.com(?::443)?\//gi, prefix)
    .replace(/https:\\\/\\\/us-displays\.burblesoft\.com(?::443)?\\\//gi, prefix.replaceAll("/", "\\/"))
    .replace(/https:\\\/\\\/dzm\.burblesoft\.com(?::443)?\\\//gi, prefix.replaceAll("/", "\\/"));
}

async function proxyBurble(req, res, match) {
  const dzId = match[1];
  const suffix = match[2] || "";
  const incoming = new URL(req.url, `http://${req.headers.host}`);
  const target = new URL(`/${suffix}${incoming.search}`, UPSTREAM).href;
  const chunks = [];
  for await (const chunk of req) chunks.push(chunk);
  const body = chunks.length ? Buffer.concat(chunks) : undefined;
  const headers = {};
  for (const name of ["accept", "accept-language", "content-type", "user-agent"]) {
    if (req.headers[name]) headers[name] = req.headers[name];
  }

  const response = await requestUpstream(dzId, target, { method: req.method, headers, body });
  const contentType = response.headers.get("content-type") || "application/octet-stream";
  const isText = /(?:text\/|javascript|json|xml|css)/i.test(contentType);
  const responseBody = isText
    ? Buffer.from(rewriteText(await response.text(), dzId))
    : Buffer.from(await response.arrayBuffer());
  const outputHeaders = {
    "Content-Type": contentType,
    "Cache-Control": "no-store"
  };
  send(res, response.status, responseBody, outputHeaders);
}

const server = http.createServer(async (req, res) => {
  try {
    const pathname = new URL(req.url, `http://${req.headers.host}`).pathname;
    const match = pathname.match(/^\/burble\/(\d+)\/?(.*)$/);
    if (match) {
      await proxyBurble(req, res, match);
      return;
    }
    serveStatic(req, res);
  } catch (error) {
    console.error(error);
    send(res, 502, `Burble proxy error: ${error.message}`, { "Content-Type": "text/plain; charset=utf-8" });
  }
});

server.listen(PORT, () => {
  console.log(`Burble Dashboard running at http://localhost:${PORT}/`);
});
