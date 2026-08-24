// Verifies a deployed contract against Etherscan's V2 API.
//
// hardhat-verify 2.0.13 still posts to the V1 endpoint, which Etherscan has
// retired, and upgrading it conflicts with the version hardhat-toolbox pins.
// So this posts the standard JSON input Hardhat already produced in
// artifacts/build-info, which is exactly what the plugin would have sent.
//
//   node scripts/verify-etherscan.js <address> [contracts/File.sol:Name]
require("dotenv").config();
const fs = require("fs");
const path = require("path");

const CHAIN_ID = 11155111;
const API = "https://api.etherscan.io/v2/api";

function findBuildInfo(target) {
  const dir = path.join(__dirname, "..", "artifacts", "build-info");
  const files = fs.readdirSync(dir).filter((f) => f.endsWith(".json"));
  for (const file of files.reverse()) {
    const info = JSON.parse(fs.readFileSync(path.join(dir, file), "utf8"));
    const [source] = target.split(":");
    if (info.input.sources[source]) {
      return info;
    }
  }
  throw new Error(`No build info contains ${target}. Run: npx hardhat compile`);
}

async function post(params) {
  const body = new URLSearchParams(params);
  const response = await fetch(`${API}?chainid=${CHAIN_ID}`, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body,
  });
  return response.json();
}

async function main() {
  const address = process.argv[2];
  const target = process.argv[3] || "contracts/WorldPulse.sol:WorldPulse";
  const apiKey = process.env.ETHERSCAN_API_KEY;
  if (!address) throw new Error("Usage: node scripts/verify-etherscan.js <address> [path:Name]");
  if (!apiKey) throw new Error("ETHERSCAN_API_KEY missing from .env");

  const info = findBuildInfo(target);
  console.log("Contract :", target);
  console.log("Address  :", address);
  console.log("Compiler :", `v${info.solcLongVersion}`);
  console.log("Optimizer:", info.input.settings.optimizer);

  const submit = await post({
    apikey: apiKey,
    module: "contract",
    action: "verifysourcecode",
    contractaddress: address,
    sourceCode: JSON.stringify(info.input),
    codeformat: "solidity-standard-json-input",
    contractname: target,
    compilerversion: `v${info.solcLongVersion}`,
  });

  if (submit.status !== "1") {
    // Already verified is a success, not a failure.
    if (String(submit.result).toLowerCase().includes("already verified")) {
      console.log("\nAlready verified.");
      return;
    }
    throw new Error(`Submission refused: ${submit.result}`);
  }

  const guid = submit.result;
  console.log("\nSubmitted, guid", guid);

  for (let attempt = 0; attempt < 20; attempt += 1) {
    await new Promise((r) => setTimeout(r, 6000));
    const check = await post({
      apikey: apiKey,
      module: "contract",
      action: "checkverifystatus",
      guid,
    });
    const result = String(check.result);
    if (result.includes("Pending")) {
      process.stdout.write(".");
      continue;
    }
    console.log("");
    if (check.status === "1" || result.toLowerCase().includes("already verified")) {
      console.log("VERIFIED:", result);
      console.log(`https://sepolia.etherscan.io/address/${address}#code`);
      return;
    }
    throw new Error(`Verification failed: ${result}`);
  }
  throw new Error("Timed out waiting for Etherscan");
}

main().catch((error) => {
  console.error("FAILED:", error.message);
  process.exitCode = 1;
});
