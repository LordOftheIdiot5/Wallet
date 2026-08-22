const { ethers, upgrades } = require("hardhat");

// The live WorldPulse proxy recorded in .openzeppelin/sepolia.json.
const PROXY = "0x53911907277be8f6E6B2d3D63A5796410EfA5A0e";
const PROXY_ADMIN = "0x4215c101dab1e2756231f1021e817c6b499b5c2e";
// One drip per address. The reserve still has to approve the proxy before any
// of it can move - see the approve step printed at the end.
const FAUCET_DRIP = ethers.parseEther("100");

// Emission settings, chosen against a 1,000,000 WPU supply and a 100 WPU drip.
//
// A day is short enough to feel and long enough that one quiet hour does not
// hand someone the budget. 1,000 a day means roughly ten active addresses each
// earn about a faucet drip per day - "a day of use doubles what you were given"
// - while a lone participant claiming the whole budget stays bounded.
//
// The minimum is 1% of a drip, so dust does not qualify, and the per-epoch cap
// is what actually limits farming: past three counted beats an address earns
// nothing more, so manufacturing beats means funding more addresses.
const EPOCH_LENGTH = 24 * 60 * 60;
const EMISSION_PER_EPOCH = ethers.parseEther("1000");
const MIN_BEAT_AMOUNT = ethers.parseEther("1");
const MAX_COUNTED_BEATS = 3;
// Ceiling on the rhythm multiplier. With a one day epoch, five consecutive days
// of participation maxes it out at a 6x weight - long enough that it cannot be
// bought in an afternoon, short enough to be reachable in a working week.
const MAX_STREAK_BONUS = 5;

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
      "function pulseCount() view returns (uint256)",
      "function faucetReserve() view returns (address)",
      "function epochLength() view returns (uint64)",
      "function maxStreakBonus() view returns (uint8)",
    ],
    ethers.provider
  );
  const supplyBefore = await before.totalSupply();
  const ownerBalanceBefore = await before.balanceOf(owner);
  const pulseCountBefore = await before.pulseCount().catch(() => 0n);
  const implementationBefore = await upgrades.erc1967.getImplementationAddress(PROXY);
  console.log("Before: supply", ethers.formatEther(supplyBefore), "WPU");
  console.log("Before: owner balance", ethers.formatEther(ownerBalanceBefore), "WPU");
  console.log("Before: pulseCount", pulseCountBefore.toString());
  console.log("Before: implementation", implementationBefore);

  const WorldPulse = await ethers.getContractFactory("WorldPulse");
  console.log("Upgrading proxy", PROXY, "...");
  // Configure the faucet in the upgrade transaction itself. initializeFaucet is
  // a reinitializer, so leaving it for a follow-up call would open a window
  // where anyone could set the reserve.
  // Reinitializers run in order and only once: faucet is 2, emission is 3.
  // Work out which step this proxy still needs, because calling one that has
  // already run reverts the whole upgrade with InvalidInitialization.
  const faucetDone = (await before.faucetReserve().catch(() => ethers.ZeroAddress))
    !== ethers.ZeroAddress;
  const emissionDone = (await before.epochLength().catch(() => 0n)) !== 0n;
  const streaksDone = (await before.maxStreakBonus().catch(() => 0n)) !== 0n;

  let call;
  if (!faucetDone) {
    call = { fn: "initializeFaucet", args: [owner, FAUCET_DRIP] };
  } else if (!emissionDone) {
    call = {
      fn: "initializeEmission",
      args: [EPOCH_LENGTH, EMISSION_PER_EPOCH, MIN_BEAT_AMOUNT, MAX_COUNTED_BEATS],
    };
  } else if (!streaksDone) {
    call = { fn: "initializeStreaks", args: [MAX_STREAK_BONUS] };
  }
  console.log("Initializer:", call ? call.fn : "none needed");

  const upgraded = await upgrades.upgradeProxy(PROXY, WorldPulse, { call });
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

  // Everything from before the append has to come through untouched. A wrong
  // __gap would show up right here, as a moved balance or a reset counter.
  const pulseCount = await settle(
    "pulseCount()",
    () => upgraded.pulseCount(),
    (value) => typeof value === "bigint"
  );
  const supplyAfter = await upgraded.totalSupply();
  const ownerBalanceAfter = await upgraded.balanceOf(owner);
  console.log("After:  supply", ethers.formatEther(supplyAfter), "WPU");
  console.log("After:  owner balance", ethers.formatEther(ownerBalanceAfter), "WPU");
  console.log("After:  pulseCount", pulseCount.toString(), `(was ${pulseCountBefore})`);

  if (supplyAfter !== supplyBefore || ownerBalanceAfter !== ownerBalanceBefore) {
    throw new Error("Balances moved across the upgrade - do not use this token until resolved");
  }
  if (pulseCount !== pulseCountBefore) {
    throw new Error(`pulseCount changed across the upgrade (${pulseCountBefore} -> ${pulseCount}) - check the storage gap`);
  }

  const reserve = await upgraded.faucetReserve();
  const drip = await upgraded.faucetAmount();
  const remaining = await upgraded.faucetRemaining();
  console.log("Faucet: reserve", reserve, "drip", ethers.formatEther(drip), "WPU");
  console.log("Faucet: claimable now", ethers.formatEther(remaining), "WPU");

  const epoch = await upgraded.epochLength();
  if (epoch > 0n) {
    console.log(
      "Emission:", ethers.formatEther(await upgraded.emissionPerEpoch()), "WPU per",
      `${Number(epoch) / 3600}h epoch,`,
      "min beat", ethers.formatEther(await upgraded.minBeatAmount()), "WPU,",
      "cap", (await upgraded.maxCountedBeatsPerEpoch()).toString(), "beats/address"
    );
    console.log("Emission: current epoch", (await upgraded.currentEpoch()).toString());
  }
  console.log("");
  console.log("State preserved. Pulse reads from storage.");
  if (remaining === 0n) {
    console.log("The faucet holds nothing until the reserve approves it. To fund it:");
    console.log(`  cast send ${PROXY} "approve(address,uint256)" ${PROXY} 100000ether \\`);
    console.log("    --rpc-url $SEPOLIA_RPC_URL --private-key $PRIVATE_KEY");
  }
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
