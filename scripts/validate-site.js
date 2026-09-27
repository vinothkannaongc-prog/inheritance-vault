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

// Launch markers (see scripts/set-launch-values.js). Until the v2 deployment's values are filled in,
// site/ holds *_TBD placeholders (V2_ADDRESS_TBD, V2_DATE_TBD and the rest), and a site that still
// has one must not be deployed: it would publish a placeholder where an address, a date or a
// transaction belongs, and the app would say v2 is not deployed. Every file under site/ except
// binary assets is read. The *_UNSET placeholders of the app's optional Base Sepolia slot are
// reported, not failed: the app treats that network as not deployed until they are filled in.
const BINARY = new Set([".png", ".jpg", ".jpeg", ".webp", ".gif", ".ico", ".woff", ".woff2", ".pdf"]);
const markerHits = [];
const unsetHits = [];
for (const file of walk(root).filter((candidate) => !BINARY.has(path.extname(candidate).toLowerCase()))) {
  fs.readFileSync(file, "utf8").split(/\r?\n/).forEach((line, index) => {
    for (const hit of line.matchAll(/\b[A-Z][A-Z0-9_]*_TBD\b/g)) markerHits.push(`${path.relative(root, file)}:${index + 1} ${hit[0]}`);
    for (const hit of line.matchAll(/\b[A-Z][A-Z0-9_]*_UNSET\b/g)) unsetHits.push(`${path.relative(root, file)}:${index + 1} ${hit[0]}`);
  });
}
if (markerHits.length) {
  const names = [...new Set(markerHits.map((hit) => hit.split(" ")[1]))].sort();
  failures.push(
    `launch markers remain in site/: ${markerHits.length} (${names.join(", ")}). Do not deploy the site until the v2 ` +
    "launch values are filled in: node scripts/set-launch-values.js --address 0x.. --block N --tx 0x.. " +
    `--date "D Month YYYY" --v1-pause-tx 0x..\n  ${markerHits.join("\n  ")}`,
  );
}
if (unsetHits.length) {
  warnings.push(`Not filled in yet (optional; the app treats that network as not deployed): ${unsetHits.join(", ")}`);
}

// Once the markers are filled in, the v2 deployment the app talks to (its Base entry in
// site/assets/app.js) and the one the app page names must be the same: app.html's footer links
// the same address and block, and the entry carries a code hash, which the app compares with the
// contract's code on every connect. set-launch-values.js writes them in one run and checks them on
// chain; a hand edit made afterwards must not publish two deployments.
{
  // One chain's entry in the app's CHAINS table (`  8453: {` to `  },`), as set-launch-values.js reads it.
  const appSlot = (text, chainId) => {
    const start = text.indexOf(`\n  ${chainId}: {`);
    if (start < 0) return null;
    const end = text.indexOf("\n  },", start);
    const body = text.slice(start, end < 0 ? undefined : end);
    const field = (name) => (new RegExp(`\\b${name}:\\s*"([^"]*)"`).exec(body) || [])[1] ?? null;
    return { contract: field("contract"), deployBlock: field("deployBlock"), codehash: field("codehash") };
  };
  const slot = appSlot(fs.readFileSync(path.join(root, "assets", "app.js"), "utf8"), 8453);
  if (!slot) {
    failures.push("assets/app.js: no Base (8453) entry in CHAINS");
  } else if (/^0x[0-9a-fA-F]{40}$/.test(slot.contract || "")) {
    const hash = String(slot.codehash || "").replace(/^0x/i, "").toLowerCase();
    if (!/^[1-9]\d*$/.test(slot.deployBlock || "")) failures.push(`assets/app.js: Base deployBlock "${slot.deployBlock}" is not a block number`);
    if (!/^[0-9a-f]{64}$/.test(hash)) failures.push(`assets/app.js: Base codehash "${slot.codehash}" is not a keccak-256 hash`);
    const appHtml = fs.readFileSync(path.join(root, "app.html"), "utf8");
    const footer = (/<div class="footer-contract">([\s\S]*?)<\/div>/.exec(appHtml) || [])[1] || "";
    const linked = (kind) => [...footer.matchAll(new RegExp(`href="https://basescan\\.org/${kind}/([^"]*)"`, "g"))].map((m) => m[1]);
    if (linked("address").join() !== slot.contract) {
      failures.push(`app.html: the footer links contract ${linked("address").join(", ") || "nothing"}, but assets/app.js uses ${slot.contract}`);
    }
    if (linked("block").join() !== slot.deployBlock) {
      failures.push(`app.html: the footer links block ${linked("block").join(", ") || "nothing"}, but assets/app.js uses ${slot.deployBlock}`);
    }
  }
}
if (!/\/app\s+[\s\S]*X-Robots-Tag:\s*noindex/i.test(fs.readFileSync(path.join(root, "_headers"), "utf8"))) {
  failures.push("_headers: missing X-Robots-Tag for /app");
}

if (warnings.length) console.warn(warnings.join("\n"));
if (failures.length) {
  console.error(failures.join("\n"));
  process.exit(1);
}
console.log(`Site validation passed: ${htmlFiles.length} HTML pages and ${sitemapUrls.size} sitemap URLs.`);
