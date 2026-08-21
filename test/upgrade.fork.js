const { expect } = require("chai");
const { ethers, network } = require("hardhat");

// Rehearses the real Sepolia upgrade against a fork, so the storage layout and
// the owner-gated upgrade path are proven before any key touches a live chain.
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
    params: [address, "0x56BC75E2D63100000"], // 100 ETH for gas
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
      // No network access, or the public RPC is refusing us. Skip rather than
      // fail the suite for everyone running tests offline.
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
      ],
      ethers.provider
    );
    baseline = {
      name: await token.name(),
      symbol: await token.symbol(),
      totalSupply: await token.totalSupply(),
      ownerBalance: await token.balanceOf(OWNER),
    };
  });

  after(async function () {
    // Drop the fork so the rest of the suite runs against a clean local chain.
    await network.provider.request({ method: "hardhat_reset", params: [] });
  });

  it("has no pulse storage before the upgrade", async function () {
    const token = new ethers.Contract(
      PROXY,
      ["function pulseCount() view returns (uint256)"],
      ethers.provider
    );
    await expect(token.pulseCount()).to.be.reverted;
  });

  it("preserves balances and activates pulse", async function () {
    const admin = new ethers.Contract(PROXY_ADMIN, PROXY_ADMIN_ABI, owner);
    expect((await admin.owner()).toLowerCase()).to.equal(OWNER.toLowerCase());

    const implementation = await ethers.deployContract("WorldPulse");
    await implementation.waitForDeployment();
    await admin.upgradeAndCall(PROXY, await implementation.getAddress(), "0x");

    const token = await ethers.getContractAt("WorldPulse", PROXY);

    // Nothing in the ERC-20 namespace may move.
    expect(await token.name()).to.equal(baseline.name);
    expect(await token.symbol()).to.equal(baseline.symbol);
    expect(await token.totalSupply()).to.equal(baseline.totalSupply);
    expect(await token.balanceOf(OWNER)).to.equal(baseline.ownerBalance);

    // The appended counters start from zero.
    expect(await token.pulseCount()).to.equal(0n);
    expect(await token.personalBeats(OWNER)).to.equal(0n);
    expect(await token.lastPulseAt(OWNER)).to.equal(0n);
  });

  it("counts a real send as a beat", async function () {
    const token = (await ethers.getContractAt("WorldPulse", PROXY)).connect(owner);
    const [recipient] = await ethers.getSigners();
    const amount = ethers.parseEther("1");

    await expect(token.transfer(recipient.address, amount))
      .to.emit(token, "PulseEvent")
      .withArgs(OWNER, amount, 1n);

    expect(await token.pulseCount()).to.equal(1n);
    expect(await token.personalBeats(OWNER)).to.equal(1n);
    expect(await token.lastPulseAt(OWNER)).to.be.greaterThan(0n);
    expect(await token.balanceOf(OWNER)).to.equal(baseline.ownerBalance - amount);
  });
});
