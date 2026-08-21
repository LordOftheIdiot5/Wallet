// Measures what the real upgrade will cost, by performing it on a Sepolia fork
// and pricing the gas at the live network rate.
const { ethers, network } = require("hardhat");

const FORK_RPC = "https://ethereum-sepolia-rpc.publicnode.com";
const PROXY = "0x53911907277be8f6E6B2d3D63A5796410EfA5A0e";
const PROXY_ADMIN = "0x4215c101dab1e2756231f1021e817c6b499b5c2e";
const OWNER = "0x8cA1470b3Ea971ADD119aDA2271e84bDBfccEA2A";

async function main() {
  // Price gas against the live chain before forking.
  const live = new ethers.JsonRpcProvider(FORK_RPC);
  const fee = await live.getFeeData();
  const ownerEth = await live.getBalance(OWNER);
  const gasPrice = fee.maxFeePerGas ?? fee.gasPrice;
  console.log("Live Sepolia gas price:", ethers.formatUnits(gasPrice, "gwei"), "gwei");
  console.log("Owner ETH balance:     ", ethers.formatEther(ownerEth), "ETH");
  live.destroy();

  await network.provider.request({
    method: "hardhat_reset",
    params: [{ forking: { jsonRpcUrl: FORK_RPC } }],
  });
  await network.provider.request({ method: "hardhat_impersonateAccount", params: [OWNER] });
  await network.provider.request({
    method: "hardhat_setBalance",
    params: [OWNER, "0x56BC75E2D63100000"],
  });
  const owner = await ethers.getSigner(OWNER);

  const implementation = await ethers.deployContract("WorldPulse", owner);
  const deployReceipt = await implementation.deploymentTransaction().wait();
  const implAddress = await implementation.getAddress();

  const admin = new ethers.Contract(
    PROXY_ADMIN,
    ["function upgradeAndCall(address,address,bytes) payable"],
    owner
  );
  const upgradeReceipt = await (await admin.upgradeAndCall(PROXY, implAddress, "0x")).wait();

  const totalGas = deployReceipt.gasUsed + upgradeReceipt.gasUsed;
  const cost = totalGas * gasPrice;
  console.log("");
  console.log("Deploy implementation gas:", deployReceipt.gasUsed.toString());
  console.log("upgradeAndCall gas:       ", upgradeReceipt.gasUsed.toString());
  console.log("Total gas:                ", totalGas.toString());
  console.log("Estimated cost:           ", ethers.formatEther(cost), "ETH");
  console.log("");
  if (ownerEth > cost * 3n) {
    console.log(`AFFORDABLE: balance covers this ~${(Number(ownerEth / cost))}x over`);
  } else if (ownerEth > cost) {
    console.log("TIGHT: balance covers it but with little margin");
  } else {
    console.log("INSUFFICIENT: needs more Sepolia ETH");
  }

  const token = await ethers.getContractAt("WorldPulse", PROXY);
  console.log("Post-upgrade pulseCount():", (await token.pulseCount()).toString());
  console.log("Post-upgrade totalSupply:", ethers.formatEther(await token.totalSupply()), "WPU");
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
