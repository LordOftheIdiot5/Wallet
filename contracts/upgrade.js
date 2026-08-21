const { ethers, upgrades } = require("hardhat");

// The live WorldPulse proxy recorded in .openzeppelin/sepolia.json.
const PROXY = "0x53911907277be8f6E6B2d3D63A5796410EfA5A0e";
const PROXY_ADMIN = "0x4215c101dab1e2756231f1021e817c6b499b5c2e";

async function main() {
  const [signer] = await ethers.getSigners();
  const network = await ethers.provider.getNetwork();
  console.log("Network:", network.name, `(chainId ${network.chainId})`);
  console.log("Signer: ", signer.address);

  // The v5 ProxyAdmin gates upgradeAndCall on owner. Fail before spending gas
  // on an implementation this signer cannot install.
  const admin = new ethers.Contract(
    PROXY_ADMIN,
    ["function owner() view returns (address)"],
    ethers.provider
  );
  const owner = await admin.owner();
  if (owner.toLowerCase() !== signer.address.toLowerCase()) {
    throw new Error(
      `Signer ${signer.address} does not own ProxyAdmin ${PROXY_ADMIN} (owner is ${owner})`
    );
  }

  const before = new ethers.Contract(
    PROXY,
    [
      "function totalSupply() view returns (uint256)",
      "function balanceOf(address) view returns (uint256)",
    ],
    ethers.provider
  );
  const supplyBefore = await before.totalSupply();
  const ownerBalanceBefore = await before.balanceOf(owner);
  const implementationBefore = await upgrades.erc1967.getImplementationAddress(PROXY);
  console.log("Before: supply", ethers.formatEther(supplyBefore), "WPU");
  console.log("Before: owner balance", ethers.formatEther(ownerBalanceBefore), "WPU");
  console.log("Before: implementation", implementationBefore);

  const WorldPulse = await ethers.getContractFactory("WorldPulse");
  console.log("Upgrading proxy", PROXY, "...");
  const upgraded = await upgrades.upgradeProxy(PROXY, WorldPulse);
  await upgraded.waitForDeployment();

  // Public RPCs are load balanced, so a read straight after the upgrade can
  // land on a backend that has not caught up yet and report the old state.
  // Retry until the new implementation is visible rather than calling it a
  // failure, which is exactly what a first run of this script did.
  async function settle(label, read, accept, attempts = 12, delayMs = 5000) {
    let last;
    for (let i = 0; i < attempts; i += 1) {
      try {
        last = await read();
        if (accept(last)) {
          return last;
        }
      } catch (error) {
        last = error.shortMessage || error.message;
      }
      if (i === 0) {
        console.log(`Waiting for ${label} to propagate...`);
      }
      await new Promise((resolve) => setTimeout(resolve, delayMs));
    }
    throw new Error(`${label} never settled (last saw: ${last}). The upgrade may still have succeeded - re-run the checks in a minute.`);
  }

  const implementation = await settle(
    "the new implementation",
    () => upgrades.erc1967.getImplementationAddress(PROXY),
    (address) => address.toLowerCase() !== implementationBefore.toLowerCase()
  );
  console.log("New implementation:", implementation, `(was ${implementationBefore})`);

  // Storage must survive the swap, and the pulse counters start fresh at zero.
  const pulseCount = await settle(
    "pulseCount()",
    () => upgraded.pulseCount(),
    (value) => typeof value === "bigint"
  );
  const supplyAfter = await upgraded.totalSupply();
  const ownerBalanceAfter = await upgraded.balanceOf(owner);
  console.log("After:  supply", ethers.formatEther(supplyAfter), "WPU");
  console.log("After:  owner balance", ethers.formatEther(ownerBalanceAfter), "WPU");
  console.log("After:  pulseCount", pulseCount.toString());

  if (supplyAfter !== supplyBefore || ownerBalanceAfter !== ownerBalanceBefore) {
    throw new Error("Balances moved across the upgrade - do not use this token until resolved");
  }
  console.log("Balances preserved. Pulse is live.");
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
