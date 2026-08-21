// Walks the whole visitor journey against a fork of live Sepolia: a brand new
// address claims, spends, and produces a beat. Proves the deployed
// configuration works for someone who is not the owner, without needing a
// second wallet or spending anything.
//
//   npx hardhat run scripts/verify-live-faucet.js
const { ethers, network } = require("hardhat");

const FORK_RPC = process.env.FORK_RPC_URL || "https://ethereum-sepolia-rpc.publicnode.com";
const PROXY = "0x53911907277be8f6E6B2d3D63A5796410EfA5A0e";

function ok(label, actual, expected) {
  const pass = actual === expected;
  console.log(`  ${pass ? "PASS" : "FAIL"}  ${label}: ${actual}${pass ? "" : ` (expected ${expected})`}`);
  if (!pass) {
    process.exitCode = 1;
  }
}

async function main() {
  const live = new ethers.JsonRpcProvider(FORK_RPC);
  const head = await live.getBlockNumber();
  live.destroy();
  console.log("Live head:", head);

  // Pin the fork to the head. Left to itself Hardhat forks some way behind,
  // which can land before the upgrade and make v2 functions look missing.
  const blockNumber = head - 2;
  await network.provider.request({
    method: "hardhat_reset",
    params: [{ forking: { jsonRpcUrl: FORK_RPC, blockNumber } }],
  });
  console.log("Forked at:", blockNumber);

  const token = await ethers.getContractAt("WorldPulse", PROXY);
  const before = {
    pulseCount: await token.pulseCount(),
    uniqueSenders: await token.uniqueSenders(),
    remaining: await token.faucetRemaining(),
    drip: await token.faucetAmount(),
  };
  console.log("Forked contract:");
  console.log("  pulseCount   ", before.pulseCount.toString());
  console.log("  uniqueSenders", before.uniqueSenders.toString());
  console.log("  claimable    ", ethers.formatEther(before.remaining), "WPU");
  console.log("");

  // A wallet nobody has ever seen, funded with gas only.
  const stranger = ethers.Wallet.createRandom().connect(ethers.provider);
  await network.provider.request({
    method: "hardhat_setBalance",
    params: [stranger.address, "0x56BC75E2D63100000"],
  });
  console.log("Stranger:", stranger.address);
  console.log("");

  console.log("1. Claim");
  ok("already claimed?", await token.faucetClaimed(stranger.address), false);
  await (await token.connect(stranger).claim()).wait();
  ok("balance after claim", ethers.formatEther(await token.balanceOf(stranger.address)),
     ethers.formatEther(before.drip));
  ok("claim counted as a beat?", await token.pulseCount(), before.pulseCount);
  ok("second claim blocked", await token.faucetClaimed(stranger.address), true);

  console.log("2. Send a beat");
  const amount = ethers.parseEther("12.5");
  await (await token.connect(stranger).transfer(
    "0x8cA1470b3Ea971ADD119aDA2271e84bDBfccEA2A", amount)).wait();
  ok("pulseCount", await token.pulseCount(), before.pulseCount + 1n);
  ok("uniqueSenders", await token.uniqueSenders(), before.uniqueSenders + 1n);
  ok("personalBeats", await token.personalBeats(stranger.address), 1n);

  console.log("3. Beat is visible without any log query");
  const [senders, amounts] = await token.recentPulse();
  ok("newest sender", senders[0], stranger.address);
  ok("newest amount", ethers.formatEther(amounts[0]), ethers.formatEther(amount));
  const lastAt = await token.networkLastPulseAt();
  ok("networkLastPulseAt set", lastAt > 0n, true);

  console.log("4. Faucet accounting");
  ok("claimable reduced by one drip",
     ethers.formatEther(await token.faucetRemaining()),
     ethers.formatEther(before.remaining - before.drip));

  await network.provider.request({ method: "hardhat_reset", params: [] });
  console.log("");
  console.log(process.exitCode ? "SOMETHING FAILED" : "Full visitor journey works against live configuration.");
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
