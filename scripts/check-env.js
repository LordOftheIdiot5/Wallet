// Confirms .env is wired correctly before any broadcast. Prints only the
// derived address and whether it can authorise the upgrade - never the key.
require("dotenv").config();
const { ethers } = require("ethers");

const PROXY_ADMIN = "0x4215c101dab1e2756231f1021e817c6b499b5c2e";

async function main() {
  const rpc = process.env.SEPOLIA_RPC_URL;
  const key = process.env.PRIVATE_KEY;

  console.log("SEPOLIA_RPC_URL set:", rpc ? "yes" : "NO - hardhat will not expose the sepolia network");
  console.log("PRIVATE_KEY set:    ", key ? "yes" : "NO");
  if (!rpc || !key) {
    throw new Error("Both values are required in .env");
  }

  let wallet;
  try {
    wallet = new ethers.Wallet(key);
  } catch (error) {
    throw new Error(`PRIVATE_KEY is not a valid key (expected 0x + 64 hex chars): ${error.shortMessage || error.message}`);
  }
  console.log("Derived address:    ", wallet.address);

  const provider = new ethers.JsonRpcProvider(rpc);
  const chainId = (await provider.getNetwork()).chainId;
  console.log("RPC chainId:        ", chainId.toString(), chainId === 11155111n ? "(Sepolia)" : "(NOT SEPOLIA)");

  const admin = new ethers.Contract(
    PROXY_ADMIN,
    ["function owner() view returns (address)"],
    provider
  );
  const owner = await admin.owner();
  const authorised = owner.toLowerCase() === wallet.address.toLowerCase();
  console.log("ProxyAdmin owner:   ", owner);
  console.log("Can upgrade:        ", authorised ? "YES" : "NO - this key does not own the ProxyAdmin");

  const balance = await provider.getBalance(wallet.address);
  console.log("Balance:            ", ethers.formatEther(balance), "ETH");
  console.log("Needs roughly 0.003 ETH:", balance > ethers.parseEther("0.003") ? "covered" : "INSUFFICIENT");
  provider.destroy();
}

main().catch((error) => {
  console.error("FAILED:", error.message);
  process.exitCode = 1;
});
