const fs = require("fs");
const path = require("path");

const root = path.resolve(__dirname, "..", "site");
const failures = [];
const warnings = [];

function walk(dir) {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const full = path.join(dir, entry.name);
    return entry.isDirectory() ? walk(full) : [full];
  });
}

function match(html, re) {
  return (html.match(re) || [])[1] || "";
}

function fail(file, message) {
  failures.push(`${path.relative(root, file)}: ${message}`);
}

const htmlFiles = walk(root).filter((file) => file.endsWith(".html"));
const sitemap = fs.readFileSync(path.join(root, "sitemap.xml"), "utf8");
const sitemapUrls = new Set([...sitemap.matchAll(/<loc>([^<]+)<\/loc>/g)].map((m) => m[1]));
const canonicals = new Map();

for (const file of htmlFiles) {
  const html = fs.readFileSync(file, "utf8");
  const title = match(html, /<title>([^<]+)<\/title>/i);
  const description = match(html, /<meta\s+name="description"\s+content="([^"]+)"/i);
  const canonical = match(html, /<link\s+rel="canonical"\s+href="([^"]+)"/i);
  const isApp = path.basename(file) === "app.html";

  if (!title) fail(file, "missing title");
  if (title.length > 65) fail(file, `title is ${title.length} characters`);
  if (!description) fail(file, "missing meta description");
  if (description.length > 160) fail(file, `meta description is ${description.length} characters`);
  if (!canonical) fail(file, "missing canonical URL");
  if (canonical.includes(".html")) fail(file, "canonical contains .html");
  if (canonical && canonicals.has(canonical)) fail(file, `duplicate canonical also used by ${canonicals.get(canonical)}`);
  if (canonical) canonicals.set(canonical, path.relative(root, file));

  if (isApp) {
    if (!/name="robots"\s+content="[^"]*noindex/i.test(html)) fail(file, "app must be noindex");
    if (sitemapUrls.has(canonical)) fail(file, "noindex app appears in sitemap");
  } else if (canonical && !sitemapUrls.has(canonical)) {
    fail(file, "indexable canonical missing from sitemap");
  }

  if (/\b(?:innerHTML|outerHTML|insertAdjacentHTML)\b/.test(html)) fail(file, "unsafe HTML injection API in page");
  if (/\sstyle=|\son(?:click|change|input|submit)=/i.test(html)) fail(file, "inline style or event handler");
  if (/href="[^"]*\.html(?:[?#"])/i.test(html)) fail(file, "internal .html link remains");

  for (const script of html.matchAll(/<script\s+type="application\/ld\+json">([\s\S]*?)<\/script>/gi)) {
    try {
      JSON.parse(script[1]);
    } catch (error) {
      fail(file, `invalid JSON-LD: ${error.message}`);
    }
  }

  const shouldHaveSocial = !isApp && !["privacy.html", "terms.html"].includes(path.basename(file));
  if (shouldHaveSocial) {
    const ogImage = match(html, /<meta\s+property="og:image"\s+content="([^"]+)"/i);
    if (!ogImage) fail(file, "missing Open Graph image");
    if (!/name="twitter:card"\s+content="summary_large_image"/i.test(html)) fail(file, "missing large Twitter card");
    if (ogImage.startsWith("https://willandkey.com/")) {
      const local = path.join(root, ogImage.slice("https://willandkey.com/".length));
      if (!fs.existsSync(local)) fail(file, `Open Graph image not found: ${ogImage}`);
    }
  }

  for (const hrefMatch of html.matchAll(/href="([^"]+)"/g)) {
    const href = hrefMatch[1];
    if (!href.startsWith("/") || href.startsWith("//")) continue;
    const route = href.split(/[?#]/)[0];
    if (!route || route.startsWith("/assets/") || route === "/favicon.png") continue;
    let candidate;
    if (route === "/") candidate = path.join(root, "index.html");
    else if (route.endsWith("/")) candidate = path.join(root, route.slice(1), "index.html");
    else candidate = path.join(root, `${route.slice(1)}.html`);
    if (!fs.existsSync(candidate)) fail(file, `broken internal route: ${href}`);
  }
}

if (sitemapUrls.has("https://willandkey.com/app")) failures.push("sitemap: app must not be included");
if (!/\/app\s+[\s\S]*X-Robots-Tag:\s*noindex/i.test(fs.readFileSync(path.join(root, "_headers"), "utf8"))) {
  failures.push("_headers: missing X-Robots-Tag for /app");
}

if (warnings.length) console.warn(warnings.join("\n"));
if (failures.length) {
  console.error(failures.join("\n"));
  process.exit(1);
}
console.log(`Site validation passed: ${htmlFiles.length} HTML pages and ${sitemapUrls.size} sitemap URLs.`);
