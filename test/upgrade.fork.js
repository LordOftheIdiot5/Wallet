const { expect } = require("chai");
const { ethers, network, upgrades } = require("hardhat");

// Rehearses the real Sepolia upgrade against a fork. The proxy already holds a
// live pulse - a supply, balances and a beat count - so the thing under test is
// that appending v2 storage preserves every one of them.
const FORK_RPC = process.env.FORK_RPC_URL || "https://ethereum-sepolia-rpc.publicnode.com";
const PROXY = "0x53911907277be8f6E6B2d3D63A5796410EfA5A0e";
const PROXY_ADMIN = "0x4215c101dab1e2756231f1021e817c6b499b5c2e";
const OWNER = "0x8cA1470b3Ea971ADD119aDA2271e84bDBfccEA2A";
const DRIP = ethers.parseEther("100");

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
      await network.provider.request({
        method: "hardhat_reset",
        params: [{ forking: { jsonRpcUrl: FORK_RPC } }],
      });
    } catch (error) {
      console.warn("Skipping fork test:", error.message);
      this.skip();
    }

    owner = await impersonate(OWNER);
    const token = new ethers.Contract(
      PROXY,
      [
        "function name() view returns (string)",
        "function symbol() view returns (string)",
        "function totalSupply() view returns (uint256)",
        "function balanceOf(address) view returns (uint256)",
        "function pulseCount() view returns (uint256)",
        "function personalBeats(address) view returns (uint256)",
        "function lastPulseAt(address) view returns (uint256)",
        "function transfer(address,uint256) returns (bool)",
      ],
      ethers.provider
    );

    // Beat on the fork before measuring. Hardhat forks a little behind the
    // head, so the live pulse may not be in the forked state yet - and
    // asserting that a zero survived the upgrade would prove nothing about
    // whether the appended storage moved anything.
    await (await token.connect(owner).transfer(OWNER, ethers.parseEther("3.7"))).wait();

    baseline = {
      name: await token.name(),
      symbol: await token.symbol(),
      totalSupply: await token.totalSupply(),
      ownerBalance: await token.balanceOf(OWNER),
      pulseCount: await token.pulseCount(),
      ownerBeats: await token.personalBeats(OWNER),
      ownerLastPulse: await token.lastPulseAt(OWNER),
    };
  });

  after(async function () {
    await network.provider.request({ method: "hardhat_reset", params: [] });
  });

  it("has no v2 storage before the upgrade", async function () {
    const token = new ethers.Contract(
      PROXY,
      ["function uniqueSenders() view returns (uint32)"],
      ethers.provider
    );
    await expect(token.uniqueSenders()).to.be.reverted;
  });

  it("passes the plugin's storage layout check", async function () {
    const WorldPulse = await ethers.getContractFactory("WorldPulse");
    // Throws if the new layout is not a clean append over what is deployed.
    await upgrades.validateUpgrade(PROXY, WorldPulse);
  });

  it("preserves every v1 value across the append", async function () {
    // Guard the guard: if these were zero the assertions below would pass
    // whether or not the upgrade wiped them.
    expect(baseline.pulseCount).to.be.greaterThan(0n, "baseline pulse must be non-zero to be meaningful");
    expect(baseline.ownerBeats).to.be.greaterThan(0n);
    expect(baseline.ownerLastPulse).to.be.greaterThan(0n);

    const admin = new ethers.Contract(PROXY_ADMIN, PROXY_ADMIN_ABI, owner);
    const implementation = await ethers.deployContract("WorldPulse");
    await implementation.waitForDeployment();

    // Configure the faucet in the same transaction as the upgrade, so there is
    // no window where the reinitializer is callable by anyone else.
    const initData = implementation.interface.encodeFunctionData("initializeFaucet", [
      OWNER,
      DRIP,
    ]);
    await admin.upgradeAndCall(PROXY, await implementation.getAddress(), initData);

    const token = await ethers.getContractAt("WorldPulse", PROXY);

    // This is the assertion that matters: a wrong __gap would corrupt these.
    expect(await token.name()).to.equal(baseline.name);
    expect(await token.symbol()).to.equal(baseline.symbol);
    expect(await token.totalSupply()).to.equal(baseline.totalSupply);
    expect(await token.balanceOf(OWNER)).to.equal(baseline.ownerBalance);
    expect(await token.pulseCount()).to.equal(baseline.pulseCount);
    expect(await token.personalBeats(OWNER)).to.equal(baseline.ownerBeats);
    expect(await token.lastPulseAt(OWNER)).to.equal(baseline.ownerLastPulse);

    // Appended slots start empty, and the faucet came up configured.
    expect(await token.uniqueSenders()).to.equal(0n);
    expect(await token.networkLastPulseAt()).to.equal(0n);
    expect(await token.faucetReserve()).to.equal(OWNER);
    expect(await token.faucetAmount()).to.equal(DRIP);
  });

  it("beats into on-chain state after the upgrade", async function () {
    const token = (await ethers.getContractAt("WorldPulse", PROXY)).connect(owner);
    const [recipient] = await ethers.getSigners();
    const amount = ethers.parseEther("2");

    await expect(token.transfer(recipient.address, amount)).to.emit(token, "PulseEvent");

    expect(await token.pulseCount()).to.equal(baseline.pulseCount + 1n);
    expect(await token.uniqueSenders()).to.equal(1n);
    expect(await token.networkLastPulseAt()).to.be.greaterThan(0n);

    const [senders, amounts] = await token.recentPulse();
    expect(senders[0]).to.equal(OWNER);
    expect(amounts[0]).to.equal(amount);
  });

  it("drips to a fresh address without counting it as a beat", async function () {
    const token = await ethers.getContractAt("WorldPulse", PROXY);
    const [, claimer] = await ethers.getSigners();

    await token.connect(owner).approve(PROXY, ethers.parseEther("1000"));
    const before = await token.pulseCount();

    await expect(token.connect(claimer).claim())
      .to.emit(token, "FaucetClaim")
      .withArgs(claimer.address, DRIP);

    expect(await token.balanceOf(claimer.address)).to.equal(DRIP);
    expect(await token.pulseCount()).to.equal(before, "a drip is distribution, not circulation");

    // And the claimer can now produce a beat of their own, which is the point.
    await token.connect(claimer).transfer(OWNER, ethers.parseEther("1"));
    expect(await token.pulseCount()).to.equal(before + 1n);
    expect(await token.uniqueSenders()).to.equal(2n);
  });
});
