// Approves the proxy to move WPU out of the faucet reserve. The allowance is
// what makes drips possible at all - the contract deliberately cannot touch the
// reserve without it - so this is the step that switches the faucet on.
//
//   npx hardhat run scripts/fund-faucet.js --network sepolia
//
// Approves 100,000 WPU by default. Override with FAUCET_APPROVE, e.g.
// FAUCET_APPROVE=1000 for ten claims, or FAUCET_APPROVE=0 to switch it off.
const { ethers } = require("hardhat");

const PROXY = "0x53911907277be8f6E6B2d3D63A5796410EfA5A0e";

async function main() {
  const [signer] = await ethers.getSigners();
  const token = await ethers.getContractAt("WorldPulse", PROXY);

  const reserve = await token.faucetReserve();
  if (reserve === ethers.ZeroAddress) {
    throw new Error("The faucet is not configured on this deployment yet");
  }
  if (reserve.toLowerCase() !== signer.address.toLowerCase()) {
    throw new Error(
      `Only the reserve can fund the faucet. Reserve is ${reserve}, signer is ${signer.address}`
    );
  }

  const drip = await token.faucetAmount();
  const target = ethers.parseEther(process.env.FAUCET_APPROVE || "100000");
  const held = await token.balanceOf(reserve);
  if (target > held) {
    throw new Error(
      `Cannot approve ${ethers.formatEther(target)} WPU - the reserve only holds ${ethers.formatEther(held)}`
    );
  }

  console.log("Reserve:  ", reserve);
  console.log("Holds:    ", ethers.formatEther(held), "WPU");
  console.log("Drip size:", ethers.formatEther(drip), "WPU");
  console.log("Approving:", ethers.formatEther(target), "WPU");

  const tx = await token.approve(PROXY, target);
  console.log("Sent:     ", tx.hash);
  await tx.wait();

  const remaining = await token.faucetRemaining();
  const claims = drip > 0n ? remaining / drip : 0n;
  console.log("");
  console.log("Claimable:", ethers.formatEther(remaining), "WPU");
  console.log("That is   ", claims.toString(), "claims at", ethers.formatEther(drip), "WPU each");
  if (remaining === 0n) {
    console.log("Faucet is now OFF - nobody can claim until it is approved again.");
  }
}

main().catch((error) => {
  console.error("FAILED:", error.shortMessage || error.message);
  process.exitCode = 1;
});
