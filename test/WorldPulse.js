const { loadFixture } = require("@nomicfoundation/hardhat-toolbox/network-helpers");
const { anyValue } = require("@nomicfoundation/hardhat-chai-matchers/withArgs");
const { expect } = require("chai");
const { ethers, upgrades } = require("hardhat");

describe("WorldPulse", function () {
  // Deploy the upgradeable WorldPulse token behind a proxy once and reuse the
  // snapshot in every test.
  async function deployWorldPulseFixture() {
    const [owner, recipient] = await ethers.getSigners();
    const WorldPulse = await ethers.getContractFactory("WorldPulse");
    const worldPulse = await upgrades.deployProxy(WorldPulse, [], {
      initializer: "initialize",
    });
    await worldPulse.waitForDeployment();
    return { worldPulse, owner, recipient };
  }

  describe("Deployment", function () {
    it("Should set the token name and symbol", async function () {
      const { worldPulse } = await loadFixture(deployWorldPulseFixture);
      expect(await worldPulse.name()).to.equal("WorldPulse");
      expect(await worldPulse.symbol()).to.equal("WPU");
    });

    it("Should mint the initial supply to the deployer", async function () {
      const { worldPulse, owner } = await loadFixture(deployWorldPulseFixture);
      const expectedSupply = ethers.parseEther("1000000");
      expect(await worldPulse.totalSupply()).to.equal(expectedSupply);
      expect(await worldPulse.balanceOf(owner.address)).to.equal(expectedSupply);
    });
  });

  describe("Transfers", function () {
    it("Should move tokens between accounts", async function () {
      const { worldPulse, owner, recipient } = await loadFixture(
        deployWorldPulseFixture
      );
      const amount = ethers.parseEther("100");
      await worldPulse.transfer(recipient.address, amount);
      expect(await worldPulse.balanceOf(recipient.address)).to.equal(amount);
    });

    it("Should emit a PulseEvent on transfer", async function () {
      const { worldPulse, owner, recipient } = await loadFixture(
        deployWorldPulseFixture
      );
      const amount = ethers.parseEther("25");
      await expect(worldPulse.transfer(recipient.address, amount))
        .to.emit(worldPulse, "PulseEvent")
        .withArgs(owner.address, amount, anyValue);
    });

    it("Should revert when sending more than the balance", async function () {
      const { worldPulse, owner, recipient } = await loadFixture(
        deployWorldPulseFixture
      );
      const tooMuch = ethers.parseEther("2000000");
      await expect(
        worldPulse.connect(recipient).transfer(owner.address, tooMuch)
      ).to.be.reverted;
    });
  });
});
