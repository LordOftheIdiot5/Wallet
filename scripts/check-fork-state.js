// Does the fork actually see the live pulse? If it forks a block from before
// the last beat, "preserved across the upgrade" asserts 0 == 0 and proves
// nothing. This compares live state against forked state directly.
const { ethers, network } = require("hardhat");

const FORK_RPC = process.env.FORK_RPC_URL || "https://ethereum-sepolia-rpc.publicnode.com";
const PROXY = "0x53911907277be8f6E6B2d3D63A5796410EfA5A0e";
const OWNER = "0x8cA1470b3Ea971ADD119aDA2271e84bDBfccEA2A";
const ABI = [
  "function pulseCount() view returns (uint256)",
  "function balanceOf(address) view returns (uint256)",
];

async function main() {
  const live = new ethers.JsonRpcProvider(FORK_RPC);
  const liveToken = new ethers.Contract(PROXY, ABI, live);
  const liveBlock = await live.getBlockNumber();
  console.log("LIVE  block      :", liveBlock);
  console.log("LIVE  pulseCount :", (await liveToken.pulseCount()).toString());
  console.log("LIVE  balance    :", ethers.formatEther(await liveToken.balanceOf(OWNER)));
  live.destroy();

  await network.provider.request({
    method: "hardhat_reset",
    params: [{ forking: { jsonRpcUrl: FORK_RPC } }],
  });
  const forkToken = new ethers.Contract(PROXY, ABI, ethers.provider);
  const forkBlock = await ethers.provider.getBlockNumber();
  console.log("");
  console.log("FORK  block      :", forkBlock);
  console.log("FORK  pulseCount :", (await forkToken.pulseCount()).toString());
  console.log("FORK  balance    :", ethers.formatEther(await forkToken.balanceOf(OWNER)));
  await network.provider.request({ method: "hardhat_reset", params: [] });
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
