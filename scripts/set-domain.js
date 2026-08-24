// Points the whole project at a custom domain, in one command.
//
//   node scripts/set-domain.js worldpulse.xyz
//   node scripts/set-domain.js --revert          (back to GitHub Pages)
//
// The site URL is hardcoded in several places that all have to agree: the
// Open Graph tags need absolute URLs, the token list needs an absolute logoURI
// or wallets show a blank icon, and GitHub Pages needs a CNAME file at the
// published root or it serves the default domain and drops the custom one on
// the next deploy.
const fs = require("fs");
const path = require("path");

const ROOT = path.join(__dirname, "..");
const DEFAULT_SITE = "https://lordoftheidiot5.github.io/Wallet";
const CNAME_PATH = path.join(ROOT, "wallet", "CNAME");

// Files that carry an absolute site URL, and must be kept in step.
const TOUCHED = [
  "README.md",
  path.join("wallet", "index.html"),
  path.join("wallet", "tokenlist.json"),
  path.join("scripts", "ship.js"),
];

// GitHub Pages apex records. Stable, but worth re-checking against
// docs.github.com if a deploy ever resolves to the wrong place.
const A_RECORDS = [
  "185.199.108.153",
  "185.199.109.153",
  "185.199.110.153",
  "185.199.111.153",
];

function currentSite() {
  const html = fs.readFileSync(path.join(ROOT, "wallet", "index.html"), "utf8");
  const match = html.match(/<meta property="og:url" content="([^"]+)"/);
  if (!match) throw new Error("Could not read the current site URL from index.html");
  return match[1].replace(/\/$/, "");
}

function rewrite(from, to) {
  let changed = 0;
  for (const rel of TOUCHED) {
    const file = path.join(ROOT, rel);
    const before = fs.readFileSync(file, "utf8");
    const after = before.split(from).join(to);
    if (after !== before) {
      fs.writeFileSync(file, after);
      const hits = before.split(from).length - 1;
      console.log(`  ${rel}: ${hits} replaced`);
      changed += hits;
    }
  }
  return changed;
}

function main() {
  const arg = process.argv[2];
  if (!arg) {
    throw new Error("Usage: node scripts/set-domain.js <domain>   |   --revert");
  }

  const from = currentSite();

  if (arg === "--revert") {
    console.log(`Reverting ${from} -> ${DEFAULT_SITE}`);
    rewrite(from, DEFAULT_SITE);
    if (fs.existsSync(CNAME_PATH)) {
      fs.unlinkSync(CNAME_PATH);
      console.log("  wallet/CNAME removed");
    }
    console.log("\nRemember to clear the custom domain in Settings > Pages too.");
    return;
  }

  const domain = arg.replace(/^https?:\/\//, "").replace(/\/$/, "");
  if (!/^[a-z0-9.-]+\.[a-z]{2,}$/i.test(domain)) {
    throw new Error(`That does not look like a domain: ${domain}`);
  }
  const to = `https://${domain}`;

  console.log(`Pointing ${from} -> ${to}`);
  const changed = rewrite(from, to);
  if (changed === 0) {
    console.log("  nothing to change - already pointed there?");
  }

  // Published from wallet/, so the CNAME has to live there to reach the root.
  fs.writeFileSync(CNAME_PATH, `${domain}\n`);
  console.log(`  wallet/CNAME written (${domain})`);

  const apex = !domain.split(".").slice(0, -2).length;
  console.log(`
Next, and only you can do these:

1. DNS at your registrar`);
  if (apex) {
    console.log(`   Four A records on @ (the apex):`);
    A_RECORDS.forEach((ip) => console.log(`     A    @    ${ip}`));
    console.log(`   And optionally:`);
    console.log(`     CNAME  www  lordoftheidiot5.github.io.`);
  } else {
    console.log(`     CNAME  ${domain.split(".")[0]}  lordoftheidiot5.github.io.`);
  }
  console.log(`
2. GitHub: Settings > Pages > Custom domain -> ${domain}
   Wait for the DNS check to pass, then tick Enforce HTTPS.
   The certificate can take up to an hour after DNS resolves.

3. Ship it:
   node scripts/ship.js "Point the site at ${domain}"

Until DNS resolves the site stays reachable at the old address.`);
}

try {
  main();
} catch (error) {
  console.error("FAILED:", error.message);
  process.exitCode = 1;
}
