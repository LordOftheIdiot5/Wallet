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
      const { worldPulse, owner } = await loadFixture(deployWorldPulseFixture);
      expect(await worldPulse.pulseCount()).to.equal(0n);
      const pulse = await worldPulse.pulseOf(owner.address);
      expect(pulse.beats).to.equal(0n);
      expect(pulse.lastAt).to.equal(0n);
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
      expect(await worldPulse.personalBeats(owner.address)).to.equal(1n);
      expect(await worldPulse.lastPulseAt(owner.address)).to.be.greaterThan(0n);
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
      expect(await worldPulse.personalBeats(alice.address)).to.equal(1n);
      expect(await worldPulse.balanceOf(bob.address)).to.equal(amount);
    });

    it("reverts when sending more than the balance", async function () {
      const { worldPulse, owner, alice } = await loadFixture(deployWorldPulseFixture);
      const tooMuch = ethers.parseEther("2000000");
      await expect(worldPulse.connect(alice).transfer(owner.address, tooMuch)).to.be
        .reverted;
    });
  });

  describe("Network pulse state", function () {
    it("records the network's last beat, not just the sender's", async function () {
      const { worldPulse, alice } = await loadFixture(deployWorldPulseFixture);
      expect(await worldPulse.networkLastPulseAt()).to.equal(0n);
      await worldPulse.transfer(alice.address, ethers.parseEther("5"));
      const at = await worldPulse.networkLastPulseAt();
      expect(at).to.be.greaterThan(0n);

      // A different sender must move it forward, which is the whole point of
      // having it separate from the per-address mapping.
      await worldPulse.connect(alice).transfer(alice.address, ethers.parseEther("1"));
      expect(await worldPulse.networkLastPulseAt()).to.be.greaterThanOrEqual(at);
    });

    it("counts each sender once, however often they beat", async function () {
      const { worldPulse, alice, bob } = await loadFixture(deployWorldPulseFixture);
      expect(await worldPulse.uniqueSenders()).to.equal(0n);

      await worldPulse.transfer(alice.address, ethers.parseEther("10"));
      expect(await worldPulse.uniqueSenders()).to.equal(1n);
      await worldPulse.transfer(bob.address, ethers.parseEther("10"));
      expect(await worldPulse.uniqueSenders()).to.equal(1n, "same sender twice is one participant");

      await worldPulse.connect(alice).transfer(bob.address, ethers.parseEther("1"));
      expect(await worldPulse.uniqueSenders()).to.equal(2n);
    });

    it("serves recent beats newest first without any log query", async function () {
      const { worldPulse, owner, alice } = await loadFixture(deployWorldPulseFixture);
      await worldPulse.transfer(alice.address, ethers.parseEther("3"));
      await worldPulse.transfer(alice.address, ethers.parseEther("7"));

      const [senders, amounts, timestamps] = await worldPulse.recentPulse();
      expect(senders[0]).to.equal(owner.address);
      expect(amounts[0]).to.equal(ethers.parseEther("7"), "newest beat first");
      expect(amounts[1]).to.equal(ethers.parseEther("3"));
      expect(timestamps[0]).to.be.greaterThan(0n);
      // Untouched ring slots stay empty rather than repeating the last beat.
      expect(senders[2]).to.equal(ethers.ZeroAddress);
    });

    it("keeps only the newest eight beats", async function () {
      const { worldPulse, alice } = await loadFixture(deployWorldPulseFixture);
      for (let i = 1; i <= 10; i += 1) {
        await worldPulse.transfer(alice.address, ethers.parseEther(String(i)));
      }
      const [, amounts] = await worldPulse.recentPulse();
      expect(amounts[0]).to.equal(ethers.parseEther("10"));
      expect(amounts[7]).to.equal(ethers.parseEther("3"), "the ring wrapped past the first two");
      expect(await worldPulse.pulseCount()).to.equal(10n, "the total still counts them all");
    });
  });

  describe("Faucet", function () {
    const DRIP = ethers.parseEther("100");

    async function withFaucet() {
      const fixture = await loadFixture(deployWorldPulseFixture);
      const { worldPulse, owner } = fixture;
      await worldPulse.initializeFaucet(owner.address, DRIP);
      await worldPulse.approve(await worldPulse.getAddress(), ethers.parseEther("1000"));
      return fixture;
    }

    it("rejects a drip larger than the cap", async function () {
      const { worldPulse, owner } = await loadFixture(deployWorldPulseFixture);
      const tooBig = (await worldPulse.MAX_FAUCET_AMOUNT()) + 1n;
      await expect(worldPulse.initializeFaucet(owner.address, tooBig)).to.be.revertedWith(
        "WorldPulse: amount out of range"
      );
    });

    it("cannot be configured twice", async function () {
      const { worldPulse, owner } = await withFaucet();
      await expect(worldPulse.initializeFaucet(owner.address, DRIP)).to.be.reverted;
    });

    it("pays one drip per address", async function () {
      const { worldPulse, alice } = await withFaucet();
      await expect(worldPulse.connect(alice).claim())
        .to.emit(worldPulse, "FaucetClaim")
        .withArgs(alice.address, DRIP);
      expect(await worldPulse.balanceOf(alice.address)).to.equal(DRIP);

      await expect(worldPulse.connect(alice).claim()).to.be.revertedWith(
        "WorldPulse: already claimed"
      );
    });

    it("does not count a drip as a beat", async function () {
      const { worldPulse, owner, alice } = await withFaucet();
      await worldPulse.connect(alice).claim();
      expect(await worldPulse.pulseCount()).to.equal(0n);
      expect(await worldPulse.personalBeats(owner.address)).to.equal(0n);
      expect(await worldPulse.uniqueSenders()).to.equal(0n);

      // But spending what was claimed is a beat, by the claimer.
      await worldPulse.connect(alice).transfer(owner.address, ethers.parseEther("1"));
      expect(await worldPulse.pulseCount()).to.equal(1n);
      expect(await worldPulse.personalBeats(alice.address)).to.equal(1n);
    });

    it("cannot move reserve tokens without an allowance", async function () {
      const { worldPulse, owner, alice } = await loadFixture(deployWorldPulseFixture);
      await worldPulse.initializeFaucet(owner.address, DRIP);
      // Configured but never approved: the reserve has not consented.
      expect(await worldPulse.faucetRemaining()).to.equal(0n);
      await expect(worldPulse.connect(alice).claim()).to.be.revertedWith(
        "WorldPulse: faucet empty"
      );
    });

    it("reports what is actually claimable", async function () {
      const { worldPulse, owner } = await loadFixture(deployWorldPulseFixture);
      await worldPulse.initializeFaucet(owner.address, DRIP);
      await worldPulse.approve(await worldPulse.getAddress(), ethers.parseEther("250"));
      expect(await worldPulse.faucetRemaining()).to.equal(ethers.parseEther("250"));
    });

    it("refuses to let the reserve drip to itself", async function () {
      const { worldPulse, owner } = await withFaucet();
      await expect(worldPulse.connect(owner).claim()).to.be.revertedWith(
        "WorldPulse: reserve cannot claim"
      );
    });
  });
});
