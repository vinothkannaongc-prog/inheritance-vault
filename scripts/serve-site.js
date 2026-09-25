// Local preview for site/ that behaves like Cloudflare Pages: clean URLs, the
// _redirects table, and every header from _headers (so the production CSP is
// enforced in the preview and violations show in the browser console).
//   node scripts/serve-site.js [port]      default port 8123
const fs = require("fs");
const http = require("http");
const path = require("path");

const root = path.resolve(__dirname, "..", "site");
const port = Number(process.argv[2] || process.env.PORT || 8123);

const types = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".xml": "application/xml; charset=utf-8",
  ".txt": "text/plain; charset=utf-8",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".webp": "image/webp",
  ".svg": "image/svg+xml",
  ".ico": "image/x-icon",
  ".woff2": "font/woff2",
  ".woff": "font/woff",
  ".pdf": "application/pdf",
};

function parseHeaders() {
  const rules = [];
  let current = null;
  const file = path.join(root, "_headers");
  if (!fs.existsSync(file)) return rules;
  for (const raw of fs.readFileSync(file, "utf8").split(/\r?\n/)) {
    if (!raw.trim()) continue;
    if (!/^\s/.test(raw)) {
      current = { pattern: raw.trim(), headers: [] };
      rules.push(current);
    } else if (current) {
      const i = raw.indexOf(":");
      current.headers.push([raw.slice(0, i).trim(), raw.slice(i + 1).trim()]);
    }
  }
  return rules;
}

function parseRedirects() {
  const file = path.join(root, "_redirects");
  if (!fs.existsSync(file)) return [];
  return fs
    .readFileSync(file, "utf8")
    .split(/\r?\n/)
    .map((l) => l.trim().split(/\s+/))
    .filter((p) => p.length >= 2)
    .map(([from, to, status]) => ({ from, to, status: Number(status || 301) }));
}

const headerRules = parseHeaders();
const redirects = parseRedirects();

function globMatch(pattern, url) {
  const re = new RegExp("^" + pattern.replace(/[.+^${}()|[\]\\]/g, "\\$&").replace(/\*/g, ".*") + "$");
  return re.test(url);
}

function applyHeaders(res, url) {
  for (const rule of headerRules) {
    if (globMatch(rule.pattern, url)) for (const [k, v] of rule.headers) res.setHeader(k, v);
  }
}

function resolve(url) {
  const clean = decodeURIComponent(url.split(/[?#]/)[0]);
  if (clean.includes("..")) return null;
  const candidates = clean.endsWith("/")
    ? [path.join(root, clean, "index.html")]
    : [path.join(root, clean), path.join(root, clean + ".html"), path.join(root, clean, "index.html")];
  for (const c of candidates) {
    if (fs.existsSync(c) && fs.statSync(c).isFile()) return c;
  }
  return null;
}

http
  .createServer((req, res) => {
    const url = req.url.split(/[?#]/)[0];
    const redirect = redirects.find((r) => r.from === url);
    if (redirect) {
      res.writeHead(redirect.status, { Location: redirect.to });
      return res.end();
    }
    const file = resolve(url);
    applyHeaders(res, url);
    if (!file) {
      res.writeHead(404, { "Content-Type": "text/plain; charset=utf-8" });
      return res.end("404 " + url);
    }
    res.setHeader("Content-Type", types[path.extname(file).toLowerCase()] || "application/octet-stream");
    res.setHeader("Cache-Control", "no-store");
    res.writeHead(200);
    fs.createReadStream(file).pipe(res);
  })
  .listen(port, () => console.log(`willandkey preview: http://localhost:${port}/  (root ${root})`));
