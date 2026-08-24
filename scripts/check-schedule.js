// Sums the whole emission schedule against the hard cap. A schedule that
// overruns the cap would not break the contract - minting stops at the ceiling
// - but it would mean the published curve is a lie after some year.
//
//   npx hardhat run scripts/check-schedule.js
const { ethers, upgrades } = require("hardhat");

const BASE = ethers.parseEther("27000");
const HALVING_EPOCHS = 365;      // one year of daily epochs
const HOLDER_SHARE_BPS = 6000;
const TARGET_BEATS = 4;
const LIVENESS_WINDOW = 7 * 86400;
const EXISTING_SUPPLY = ethers.parseEther("1001000");

async function main() {
  const WorldPulse = await ethers.getContractFactory("WorldPulse");
  const t = await upgrades.deployProxy(WorldPulse, [], { initializer: "initialize" });
  await t.waitForDeployment();
  await t.initializeFaucet((await ethers.getSigners())[0].address, ethers.parseEther("100"));
  await t.initializeEmission(86400, ethers.parseEther("1000"), ethers.parseEther("1"), 3);
  await t.initializeStreaks(5);
  await t.initializeIntroductions(4);
  await t.initializeSupplyPolicy(BASE, HALVING_EPOCHS, HOLDER_SHARE_BPS, TARGET_BEATS, LIVENESS_WINDOW);

  const cap = await t.MAX_SUPPLY();
  const start = await t.emissionStartEpoch();

  let total = 0n;
  const years = [];
  for (let period = 0; period < 64; period += 1) {
    const epoch = start + BigInt(period * HALVING_EPOCHS);
    const perEpoch = await t.scheduledEmission(epoch);
    if (perEpoch === 0n) break;
    const inPeriod = perEpoch * BigInt(HALVING_EPOCHS);
    total += inPeriod;
    if (period < 6) {
      years.push(`  year ${period + 1}: ${ethers.formatEther(perEpoch)}/epoch, ${ethers.formatEther(inPeriod)} total`);
    }
  }

  console.log("Schedule: base", ethers.formatEther(BASE), "halving every", HALVING_EPOCHS, "epochs");
  years.forEach((line) => console.log(line));
  console.log("  ...");
  console.log("");
  console.log("Total ever emitted (if every epoch is fully active):");
  console.log("  emission        ", ethers.formatEther(total), "WPU");
  console.log("  already minted  ", ethers.formatEther(EXISTING_SUPPLY), "WPU");
  console.log("  final supply    ", ethers.formatEther(total + EXISTING_SUPPLY), "WPU");
  console.log("  hard cap        ", ethers.formatEther(cap), "WPU");

  const fits = total + EXISTING_SUPPLY <= cap;
  console.log("");
  console.log(fits
    ? `FITS: ${ethers.formatEther(cap - total - EXISTING_SUPPLY)} WPU of margin under the cap`
    : `OVERRUNS by ${ethers.formatEther(total + EXISTING_SUPPLY - cap)} WPU - the curve would be cut short`);
  if (!fits) process.exitCode = 1;

  // And what a realistic, less-than-fully-active network actually emits.
  console.log("");
  console.log("At 50% average activity, first year emits",
    ethers.formatEther((BASE * BigInt(HALVING_EPOCHS)) / 2n), "WPU");
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
