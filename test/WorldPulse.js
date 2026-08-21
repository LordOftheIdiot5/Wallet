const { loadFixture } = require("@nomicfoundation/hardhat-toolbox/network-helpers");
const { expect } = require("chai");
const { ethers, upgrades } = require("hardhat");

describe("WorldPulse", function () {
  async function deployWorldPulseFixture() {
    const [owner, alice, bob] = await ethers.getSigners();
    const WorldPulse = await ethers.getContractFactory("WorldPulse");
    const worldPulse = await upgrades.deployProxy(WorldPulse, [], {
      initializer: "initialize",
    });
    await worldPulse.waitForDeployment();
    return { worldPulse, owner, alice, bob };
  }

  describe("Deployment", function () {
    it("sets the token name and symbol", async function () {
      const { worldPulse } = await loadFixture(deployWorldPulseFixture);
      expect(await worldPulse.name()).to.equal("WorldPulse");
      expect(await worldPulse.symbol()).to.equal("WPU");
    });

    it("mints the initial supply to the deployer", async function () {
      const { worldPulse, owner } = await loadFixture(deployWorldPulseFixture);
      const expectedSupply = ethers.parseEther("1000000");
      expect(await worldPulse.totalSupply()).to.equal(expectedSupply);
      expect(await worldPulse.balanceOf(owner.address)).to.equal(expectedSupply);
    });

    it("does not count the initial mint as a pulse", async function () {
      const { worldPulse } = await loadFixture(deployWorldPulseFixture);
      expect(await worldPulse.pulseCount()).to.equal(0n);
    });

    it("rejects a second initialize call", async function () {
      const { worldPulse } = await loadFixture(deployWorldPulseFixture);
      await expect(worldPulse.initialize()).to.be.reverted;
    });
  });

  describe("Transfers", function () {
    it("moves tokens between accounts", async function () {
      const { worldPulse, alice } = await loadFixture(deployWorldPulseFixture);
      const amount = ethers.parseEther("100");
      await worldPulse.transfer(alice.address, amount);
      expect(await worldPulse.balanceOf(alice.address)).to.equal(amount);
    });

    it("emits PulseEvent and increments pulseCount on transfer", async function () {
      const { worldPulse, owner, alice } = await loadFixture(deployWorldPulseFixture);
      const amount = ethers.parseEther("25");
      await expect(worldPulse.transfer(alice.address, amount))
        .to.emit(worldPulse, "PulseEvent")
        .withArgs(owner.address, amount, 1n);
      expect(await worldPulse.pulseCount()).to.equal(1n);
    });

    it("emits PulseEvent on transferFrom from the token owner", async function () {
      const { worldPulse, alice, bob } = await loadFixture(deployWorldPulseFixture);
      const amount = ethers.parseEther("40");
      await worldPulse.transfer(alice.address, amount);
      await worldPulse.connect(alice).approve(bob.address, amount);

      await expect(
        worldPulse.connect(bob).transferFrom(alice.address, bob.address, amount)
      )
        .to.emit(worldPulse, "PulseEvent")
        .withArgs(alice.address, amount, 2n);

      expect(await worldPulse.pulseCount()).to.equal(2n);
      expect(await worldPulse.balanceOf(bob.address)).to.equal(amount);
    });

    it("reverts when sending more than the balance", async function () {
      const { worldPulse, owner, alice } = await loadFixture(deployWorldPulseFixture);
      const tooMuch = ethers.parseEther("2000000");
      await expect(worldPulse.connect(alice).transfer(owner.address, tooMuch)).to.be
        .reverted;
    });
  });
});
