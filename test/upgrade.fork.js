const { expect } = require("chai");
const { ethers, network, upgrades } = require("hardhat");

// Rehearses the next Sepolia upgrade against a fork of the live proxy, which
// already carries a pulse, a faucet and real balances. The thing under test is
// that appending v3 emission storage disturbs none of it.
const FORK_RPC = process.env.FORK_RPC_URL || "https://ethereum-sepolia-rpc.publicnode.com";
const PROXY = "0x53911907277be8f6E6B2d3D63A5796410EfA5A0e";
const PROXY_ADMIN = "0x4215c101dab1e2756231f1021e817c6b499b5c2e";
const OWNER = "0x8cA1470b3Ea971ADD119aDA2271e84bDBfccEA2A";

const EPOCH = 86400;
const EMISSION = ethers.parseEther("1000");
const MIN_BEAT = ethers.parseEther("1");
const CAP = 3;

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

  before(async function () {
    try {
      const live = new ethers.JsonRpcProvider(FORK_RPC);
      const head = await live.getBlockNumber();
      live.destroy();
      // Pin to the head. Left alone Hardhat forks far enough behind that a
      // recent upgrade looks like it never happened.
      await network.provider.request({
        method: "hardhat_reset",
        params: [{ forking: { jsonRpcUrl: FORK_RPC, blockNumber: head - 2 } }],
      });
    } catch (error) {
      console.warn("Skipping fork test:", error.message);
      this.skip();
    }

    owner = await impersonate(OWNER);
    const token = await ethers.getContractAt("WorldPulse", PROXY);

    // Beat before measuring, so the preservation checks below compare against
    // values that are actually non-zero.
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
    };
  });

  after(async function () {
    await network.provider.request({ method: "hardhat_reset", params: [] });
  });

  it("has no v3 storage before the upgrade", async function () {
    const token = new ethers.Contract(
      PROXY,
      ["function epochLength() view returns (uint64)"],
      ethers.provider
    );
    await expect(token.epochLength()).to.be.reverted;
  });

  it("passes the plugin's storage layout check", async function () {
    const WorldPulse = await ethers.getContractFactory("WorldPulse");
    await upgrades.validateUpgrade(PROXY, WorldPulse);
  });

  it("preserves v1 and v2 state across the append", async function () {
    // If these were zero the assertions below would pass whether or not the
    // upgrade wiped them.
    expect(baseline.pulseCount).to.be.greaterThan(0n, "baseline must be non-zero to mean anything");
    expect(baseline.uniqueSenders).to.be.greaterThan(0n);
    expect(baseline.faucetReserve).to.not.equal(ethers.ZeroAddress);

    const admin = new ethers.Contract(PROXY_ADMIN, PROXY_ADMIN_ABI, owner);
    const implementation = await ethers.deployContract("WorldPulse");
    await implementation.waitForDeployment();

    // Configure emission in the upgrade transaction, so the reinitializer is
    // never callable by anyone else.
    const initData = implementation.interface.encodeFunctionData("initializeEmission", [
      EPOCH, EMISSION, MIN_BEAT, CAP,
    ]);
    await admin.upgradeAndCall(PROXY, await implementation.getAddress(), initData);

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

    // And emission came up configured, with nothing accrued yet.
    expect(await token.epochLength()).to.equal(BigInt(EPOCH));
    expect(await token.emissionPerEpoch()).to.equal(EMISSION);
    expect(await token.epochBeats(await token.currentEpoch())).to.equal(0n);
  });

  it("credits emission for a qualifying beat after the upgrade", async function () {
    const token = await ethers.getContractAt("WorldPulse", PROXY);
    const [recipient] = await ethers.getSigners();
    const epoch = await token.currentEpoch();

    await (await token.connect(owner).transfer(recipient.address, ethers.parseEther("4"))).wait();
    expect(await token.epochBeatsOf(epoch, OWNER)).to.equal(1n);

    // Dust and self-shuffling stay worthless on the live configuration too.
    await (await token.connect(owner).transfer(recipient.address, 1n)).wait();
    await (await token.connect(owner).transfer(OWNER, ethers.parseEther("4"))).wait();
    expect(await token.epochBeatsOf(epoch, OWNER)).to.equal(1n);
  });
});
