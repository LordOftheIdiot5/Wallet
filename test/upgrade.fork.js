const { expect } = require("chai");
const { ethers, network, upgrades } = require("hardhat");

// Rehearses upgrading the live proxy to whatever the current source is.
//
// Deliberately version-agnostic. Earlier versions of this file asserted "v2
// storage is absent" or called a specific reinitializer, and went stale the
// moment that upgrade shipped. What stays true across every upgrade is the
// property worth testing: nothing that existed before may move.
const FORK_RPC = process.env.FORK_RPC_URL || "https://ethereum-sepolia-rpc.publicnode.com";
const PROXY = "0x53911907277be8f6E6B2d3D63A5796410EfA5A0e";
const PROXY_ADMIN = "0x4215c101dab1e2756231f1021e817c6b499b5c2e";
const OWNER = "0x8cA1470b3Ea971ADD119aDA2271e84bDBfccEA2A";

const PROXY_ADMIN_ABI = [
  "function owner() view returns (address)",
  "function upgradeAndCall(address proxy, address implementation, bytes data) payable",
];

async function impersonate(address) {
  await network.provider.request({ method: "hardhat_impersonateAccount", params: [address] });
  await network.provider.request({
    method: "hardhat_setBalance",
    params: [address, "0x56BC75E2D63100000"],
  });
  return ethers.getSigner(address);
}

describe("Sepolia upgrade (fork)", function () {
  this.timeout(180_000);

  let owner;
  let baseline;
  let liveHead;

  before(async function () {
    try {
      const live = new ethers.JsonRpcProvider(FORK_RPC);
      liveHead = await live.getBlockNumber();
      live.destroy();
      // Pinned. Unpinned, Hardhat forks far enough behind that a recent upgrade
      // looks like it never happened - which has produced two false results here.
      await network.provider.request({
        method: "hardhat_reset",
        params: [{ forking: { jsonRpcUrl: FORK_RPC, blockNumber: liveHead - 2 } }],
      });
    } catch (error) {
      console.warn("Skipping fork test:", error.message);
      this.skip();
    }

    owner = await impersonate(OWNER);
    const token = await ethers.getContractAt("WorldPulse", PROXY);

    // Beat before measuring, so preservation is checked against values that are
    // actually non-zero rather than passing vacuously on a fresh chain.
    const [recipient] = await ethers.getSigners();
    await (await token.connect(owner).transfer(recipient.address, ethers.parseEther("3.7"))).wait();

    baseline = {
      name: await token.name(),
      totalSupply: await token.totalSupply(),
      ownerBalance: await token.balanceOf(OWNER),
      pulseCount: await token.pulseCount(),
      ownerBeats: await token.personalBeats(OWNER),
      uniqueSenders: await token.uniqueSenders(),
      networkLastPulseAt: await token.networkLastPulseAt(),
      faucetReserve: await token.faucetReserve(),
      faucetAmount: await token.faucetAmount(),
      faucetRemaining: await token.faucetRemaining(),
      epochLength: await token.epochLength().catch(() => 0n),
      emissionPerEpoch: await token.emissionPerEpoch().catch(() => 0n),
    };
  });

  after(async function () {
    await network.provider.request({ method: "hardhat_reset", params: [] });
  });

  it("forked recent enough to be testing the live contract", async function () {
    // Cheap guard against the failure mode that has bitten this file twice: a
    // stale fork silently tests an old implementation and reports success.
    const token = await ethers.getContractAt("WorldPulse", PROXY);
    expect(await token.pulseCount()).to.be.greaterThan(0n);
    expect(await token.faucetReserve()).to.not.equal(ethers.ZeroAddress);
  });

  it("passes the plugin's storage layout check", async function () {
    const WorldPulse = await ethers.getContractFactory("WorldPulse");
    await upgrades.validateUpgrade(PROXY, WorldPulse);
  });

  it("preserves every existing value across the upgrade", async function () {
    expect(baseline.pulseCount).to.be.greaterThan(0n, "baseline must be non-zero to mean anything");

    const admin = new ethers.Contract(PROXY_ADMIN, PROXY_ADMIN_ABI, owner);
    const implementation = await ethers.deployContract("WorldPulse");
    await implementation.waitForDeployment();

    // Work out which reinitializer, if any, this proxy still needs - the same
    // logic upgrade.js uses, so the rehearsal matches the real thing.
    let data = "0x";
    if (baseline.faucetReserve === ethers.ZeroAddress) {
      data = implementation.interface.encodeFunctionData("initializeFaucet", [
        OWNER, ethers.parseEther("100"),
      ]);
    } else if (baseline.epochLength === 0n) {
      data = implementation.interface.encodeFunctionData("initializeEmission", [
        86400, ethers.parseEther("1000"), ethers.parseEther("1"), 3,
      ]);
    }
    await admin.upgradeAndCall(PROXY, await implementation.getAddress(), data);

    const token = await ethers.getContractAt("WorldPulse", PROXY);
    expect(await token.name()).to.equal(baseline.name);
    expect(await token.totalSupply()).to.equal(baseline.totalSupply);
    expect(await token.balanceOf(OWNER)).to.equal(baseline.ownerBalance);
    expect(await token.pulseCount()).to.equal(baseline.pulseCount);
    expect(await token.personalBeats(OWNER)).to.equal(baseline.ownerBeats);
    expect(await token.uniqueSenders()).to.equal(baseline.uniqueSenders);
    expect(await token.networkLastPulseAt()).to.equal(baseline.networkLastPulseAt);
    expect(await token.faucetReserve()).to.equal(baseline.faucetReserve);
    expect(await token.faucetAmount()).to.equal(baseline.faucetAmount);
    expect(await token.faucetRemaining()).to.equal(baseline.faucetRemaining);
  });

  it("still beats and still credits emission after the upgrade", async function () {
    const token = await ethers.getContractAt("WorldPulse", PROXY);
    const [recipient] = await ethers.getSigners();
    const epoch = await token.currentEpoch();
    const beatsBefore = await token.pulseCount();
    const creditedBefore = await token.epochBeatsOf(epoch, OWNER);
    const cap = await token.maxCountedBeatsPerEpoch();

    await (await token.connect(owner).transfer(recipient.address, ethers.parseEther("4"))).wait();
    expect(await token.pulseCount()).to.equal(beatsBefore + 1n, "movement is always a beat");

    // Credit rises unless this address has already used up the epoch's cap.
    const creditedAfter = await token.epochBeatsOf(epoch, OWNER);
    if (creditedBefore < cap) {
      expect(creditedAfter).to.equal(creditedBefore + 1n);
    } else {
      expect(creditedAfter).to.equal(cap, "capped addresses stop earning");
    }

    // Dust and self-shuffling never earn, whatever the cap situation.
    const before = await token.epochBeatsOf(epoch, OWNER);
    await (await token.connect(owner).transfer(recipient.address, 1n)).wait();
    await (await token.connect(owner).transfer(OWNER, ethers.parseEther("4"))).wait();
    expect(await token.epochBeatsOf(epoch, OWNER)).to.equal(before);
  });
});
