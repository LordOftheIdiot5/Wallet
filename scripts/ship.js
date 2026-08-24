// Commit, push to main, wait for Pages to deploy, then check the live site is
// actually serving the change. One command instead of branch, PR, merge, wait,
// guess.
//
//   node scripts/ship.js "commit message" [expected-string-in-app.js]
//
// The optional second argument is a string that must appear in the deployed
// app.js. Without it this reports that a run went green, which is not the same
// as the change being live - a distinction that has bitten this project twice
// through stale caches.
const { execSync } = require("child_process");

const REPO = "LordOftheIdiot5/Wallet";
const SITE = "https://lordoftheidiot5.github.io/Wallet";

const run = (cmd) => execSync(cmd, { encoding: "utf8", stdio: ["pipe", "pipe", "pipe"] }).trim();
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function latestRun() {
  const response = await fetch(
    `https://api.github.com/repos/${REPO}/actions/runs?per_page=1`,
    { headers: { Accept: "application/vnd.github+json" } }
  );
  const data = await response.json();
  return (data.workflow_runs || [])[0];
}

async function main() {
  const message = process.argv[2];
  const expect = process.argv[3];
  if (!message) throw new Error('Usage: node scripts/ship.js "message" [expected-string]');

  const branch = run("git rev-parse --abbrev-ref HEAD");
  if (branch !== "main") {
    throw new Error(`On ${branch}, not main. Switch first or this ships nothing.`);
  }

  const dirty = run("git status --porcelain");
  if (dirty) {
    run("git add -A");
    execSync(`git commit -q -F -`, { input: message, encoding: "utf8" });
    console.log("committed:", message.split("\n")[0]);
  } else {
    console.log("nothing to commit, shipping what is already on main");
  }

  run("git push");
  const sha = run("git rev-parse --short HEAD");
  console.log("pushed  :", sha);

  process.stdout.write("deploy  : ");
  let conclusion = null;
  for (let attempt = 0; attempt < 40; attempt += 1) {
    await sleep(10000);
    const current = await latestRun();
    if (!current || !current.head_sha.startsWith(sha)) {
      process.stdout.write("~");
      continue;
    }
    if (current.status !== "completed") {
      process.stdout.write(".");
      continue;
    }
    conclusion = current.conclusion;
    break;
  }
  console.log("");
  if (conclusion !== "success") {
    throw new Error(`Pages run ended as ${conclusion || "unknown"}`);
  }
  console.log("deploy  : success");

  if (!expect) {
    console.log(`\nLive: ${SITE}/  (no content check requested)`);
    return;
  }

  // A green run only means the artifact uploaded. Confirm the bytes changed.
  for (let attempt = 0; attempt < 12; attempt += 1) {
    const served = await fetch(`${SITE}/app.js?cb=${Date.now()}`, { cache: "no-store" })
      .then((r) => r.text())
      .catch(() => "");
    if (served.includes(expect)) {
      console.log(`content : "${expect}" is live`);
      console.log(`\nLive: ${SITE}/`);
      return;
    }
    process.stdout.write(attempt === 0 ? "content : waiting for the CDN " : ".");
    await sleep(8000);
  }
  throw new Error(`Deployed, but "${expect}" is not in the served app.js yet`);
}

main().catch((error) => {
  console.error("\nFAILED:", error.message);
  process.exitCode = 1;
});
