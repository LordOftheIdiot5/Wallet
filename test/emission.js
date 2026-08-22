const { loadFixture, time } = require("@nomicfoundation/hardhat-toolbox/network-helpers");
const { expect } = require("chai");
const { ethers, upgrades } = require("hardhat");

const EPOCH = 3600;                              // one hour
const EMISSION = ethers.parseEther("1000");      // per epoch
const MIN_BEAT = ethers.parseEther("1");         // dust does not qualify
const CAP = 3;                                   // counted beats per address per epoch
const MAX_STREAK_BONUS = 5;                      // ceiling on the regularity multiplier

describe("Circulation-weighted emission", function () {
  async function deployFixture() {
    const [owner, alice, bob, mallory, m2, m3] = await ethers.getSigners();
    const WorldPulse = await ethers.getContractFactory("WorldPulse");
    const worldPulse = await upgrades.deployProxy(WorldPulse, [], { initializer: "initialize" });
    await worldPulse.waitForDeployment();
    // Reinitializers must run in order: faucet is 2, emission is 3.
    await worldPulse.initializeFaucet(owner.address, ethers.parseEther("100"));
    await worldPulse.initializeEmission(EPOCH, EMISSION, MIN_BEAT, CAP);
    await worldPulse.initializeStreaks(MAX_STREAK_BONUS);

    // Give the players something to move.
    for (const who of [alice, bob, mallory, m2, m3]) {
      await worldPulse.transfer(who.address, ethers.parseEther("1000"));
    }
    // Those hand-outs are themselves qualifying beats by the owner, which would
    // sit in the same epoch as the test and skew every share. Roll past them so
    // each test starts from an epoch nobody has contributed to.
    await time.increase(EPOCH + 1);
    return { worldPulse, owner, alice, bob, mallory, m2, m3 };
  }

  async function nextEpoch() {
    await time.increase(EPOCH + 1);
  }

  describe("Honest distribution", function () {
    it("splits an epoch evenly between equal contributors", async function () {
      const { worldPulse, alice, bob } = await loadFixture(deployFixture);
      const epoch = await worldPulse.currentEpoch();

      await worldPulse.connect(alice).transfer(bob.address, ethers.parseEther("5"));
      await worldPulse.connect(bob).transfer(alice.address, ethers.parseEther("5"));
      await nextEpoch();

      expect(await worldPulse.claimableEmission(alice.address, epoch)).to.equal(EMISSION / 2n);
      expect(await worldPulse.claimableEmission(bob.address, epoch)).to.equal(EMISSION / 2n);
    });

    it("pays in proportion to reach, not to repetition", async function () {
      const { worldPulse, alice, bob, mallory, m2 } = await loadFixture(deployFixture);
      const epoch = await worldPulse.currentEpoch();

      // Alice spreads across three counterparties; Bob hammers one.
      for (const who of [bob, mallory, m2]) {
        await worldPulse.connect(alice).transfer(who.address, ethers.parseEther("2"));
      }
      for (let i = 0; i < 3; i += 1) {
        await worldPulse.connect(bob).transfer(alice.address, ethers.parseEther("2"));
      }
      await nextEpoch();

      expect(await worldPulse.epochBeatsOf(epoch, alice.address)).to.equal(3n);
      expect(await worldPulse.epochBeatsOf(epoch, bob.address)).to.equal(3n, "same beat count");
      expect(await worldPulse.epochReach(epoch, alice.address)).to.equal(3n);
      expect(await worldPulse.epochReach(epoch, bob.address)).to.equal(1n, "but one counterparty");

      // Equal streaks, so weight is reach alone: 3 versus 1.
      expect(await worldPulse.claimableEmission(alice.address, epoch)).to.equal(EMISSION * 3n / 4n);
      expect(await worldPulse.claimableEmission(bob.address, epoch)).to.equal(EMISSION / 4n);
    });

    it("mints on claim without touching anyone else's balance", async function () {
      const { worldPulse, alice, bob } = await loadFixture(deployFixture);
      const epoch = await worldPulse.currentEpoch();
      await worldPulse.connect(alice).transfer(bob.address, ethers.parseEther("5"));
      await nextEpoch();

      const supplyBefore = await worldPulse.totalSupply();
      const bobBefore = await worldPulse.balanceOf(bob.address);

      await expect(worldPulse.connect(alice).claimEmission(epoch))
        .to.emit(worldPulse, "EmissionClaimed")
        .withArgs(alice.address, epoch, EMISSION);

      expect(await worldPulse.totalSupply()).to.equal(supplyBefore + EMISSION);
      expect(await worldPulse.balanceOf(bob.address)).to.equal(bobBefore, "emission is additive only");
    });

    it("never pays out more than the epoch's budget", async function () {
      const { worldPulse, alice, bob, mallory } = await loadFixture(deployFixture);
      const epoch = await worldPulse.currentEpoch();
      await worldPulse.connect(alice).transfer(bob.address, ethers.parseEther("2"));
      await worldPulse.connect(bob).transfer(mallory.address, ethers.parseEther("2"));
      await worldPulse.connect(mallory).transfer(alice.address, ethers.parseEther("2"));
      await nextEpoch();

      let paid = 0n;
      for (const who of [alice, bob, mallory]) {
        const before = await worldPulse.balanceOf(who.address);
        await worldPulse.connect(who).claimEmission(epoch);
        paid += (await worldPulse.balanceOf(who.address)) - before;
      }
      // Integer division rounds down, so the total can only come in under budget.
      expect(paid).to.be.lessThanOrEqual(EMISSION);
      expect(paid).to.be.greaterThan(EMISSION - 10n, "and only by dust");
    });
  });

  describe("Farming resistance", function () {
    it("ignores shuffling between your own addresses", async function () {
      const { worldPulse, alice } = await loadFixture(deployFixture);
      const epoch = await worldPulse.currentEpoch();
      await worldPulse.connect(alice).transfer(alice.address, ethers.parseEther("5"));
      await nextEpoch();

      expect(await worldPulse.epochBeatsOf(epoch, alice.address)).to.equal(0n);
      expect(await worldPulse.claimableEmission(alice.address, epoch)).to.equal(0n);
    });

    it("ignores dust below the minimum", async function () {
      const { worldPulse, alice, bob } = await loadFixture(deployFixture);
      const epoch = await worldPulse.currentEpoch();
      for (let i = 0; i < 20; i += 1) {
        await worldPulse.connect(alice).transfer(bob.address, 1n); // 1 wei
      }
      await nextEpoch();

      expect(await worldPulse.epochBeatsOf(epoch, alice.address)).to.equal(0n);
      // The pulse metric still records them - it reports movement honestly,
      // it just does not pay for it.
      expect(await worldPulse.personalBeats(alice.address)).to.equal(20n);
    });

    it("stops counting past the per-epoch cap", async function () {
      const { worldPulse, alice, bob } = await loadFixture(deployFixture);
      const epoch = await worldPulse.currentEpoch();
      for (let i = 0; i < 10; i += 1) {
        await worldPulse.connect(alice).transfer(bob.address, ethers.parseEther("2"));
      }
      await nextEpoch();
      expect(await worldPulse.epochBeatsOf(epoch, alice.address)).to.equal(BigInt(CAP));
    });

    it("bounds but does not eliminate the gain from extra addresses", async function () {
      // Honest: one address, hits the cap. Attacker: three addresses, each hits
      // the cap. This documents the real limit of the defence - the cap makes
      // farming cost gas and funded addresses, it does not make it pointless.
      const { worldPulse, alice, mallory, m2, m3, bob } = await loadFixture(deployFixture);
      const epoch = await worldPulse.currentEpoch();

      for (let i = 0; i < 5; i += 1) {
        await worldPulse.connect(alice).transfer(bob.address, ethers.parseEther("2"));
      }
      for (const sock of [mallory, m2, m3]) {
        for (let i = 0; i < 5; i += 1) {
          await worldPulse.connect(sock).transfer(bob.address, ethers.parseEther("2"));
        }
      }
      await nextEpoch();

      const honest = await worldPulse.claimableEmission(alice.address, epoch);
      let attacker = 0n;
      for (const sock of [mallory, m2, m3]) {
        attacker += await worldPulse.claimableEmission(sock.address, epoch);
      }
      // Each address capped at CAP, so the split is 3:9 - the attacker's gain is
      // exactly linear in addresses funded, never super-linear in transactions.
      expect(honest).to.equal(EMISSION / 4n);
      expect(attacker).to.equal(EMISSION * 3n / 4n);
    });

    it("does not let a faucet drip earn emission", async function () {
      const { worldPulse, owner, alice } = await loadFixture(deployFixture);
      const epoch = await worldPulse.currentEpoch();
      await worldPulse.approve(await worldPulse.getAddress(), ethers.parseEther("1000"));
      await worldPulse.connect(alice).claim();
      await nextEpoch();
      expect(await worldPulse.epochBeatsOf(epoch, owner.address)).to.equal(0n);
    });
  });

  describe("Rhythm", function () {
    // increase(EPOCH + 1) can straddle a boundary and skip an epoch, which
    // would break a streak by accident. Land exactly inside the next one.
    async function stepOneEpoch(worldPulse) {
      const epoch = await worldPulse.currentEpoch();
      await time.increaseTo((epoch + 1n) * BigInt(EPOCH) + 5n);
    }

    it("builds a streak over consecutive epochs", async function () {
      const { worldPulse, alice, bob } = await loadFixture(deployFixture);
      for (let i = 0; i < 4; i += 1) {
        await worldPulse.connect(alice).transfer(bob.address, ethers.parseEther("2"));
        await stepOneEpoch(worldPulse);
      }
      expect(await worldPulse.streak(alice.address)).to.equal(4n);
    });

    it("resets a streak after a missed epoch", async function () {
      const { worldPulse, alice, bob } = await loadFixture(deployFixture);
      await worldPulse.connect(alice).transfer(bob.address, ethers.parseEther("2"));
      await stepOneEpoch(worldPulse);
      await worldPulse.connect(alice).transfer(bob.address, ethers.parseEther("2"));
      expect(await worldPulse.streak(alice.address)).to.equal(2n);

      await stepOneEpoch(worldPulse);
      await stepOneEpoch(worldPulse); // sat one out
      await worldPulse.connect(alice).transfer(bob.address, ethers.parseEther("2"));
      expect(await worldPulse.streak(alice.address)).to.equal(1n, "rhythm broken, start again");
    });

    it("caps the streak bonus", async function () {
      const { worldPulse, alice, bob } = await loadFixture(deployFixture);
      for (let i = 0; i < MAX_STREAK_BONUS + 4; i += 1) {
        await worldPulse.connect(alice).transfer(bob.address, ethers.parseEther("2"));
        await stepOneEpoch(worldPulse);
      }
      const epoch = (await worldPulse.currentEpoch()) - 1n;
      expect(await worldPulse.streak(alice.address)).to.be.greaterThan(BigInt(MAX_STREAK_BONUS));
      // reach 1 x (1 + capped bonus)
      expect(await worldPulse.weightOf(alice.address, epoch))
        .to.equal(BigInt(1 + MAX_STREAK_BONUS));
    });

    it("lets a regular participant hold their own against sock puppets", async function () {
      // The point of rhythm: an attacker can fund three addresses instantly,
      // but cannot fake having shown up every epoch for a week.
      const { worldPulse, alice, bob, mallory, m2, m3 } = await loadFixture(deployFixture);

      // Alice beats every epoch for six epochs running.
      for (let i = 0; i < 6; i += 1) {
        await worldPulse.connect(alice).transfer(bob.address, ethers.parseEther("2"));
        if (i < 5) {
          await stepOneEpoch(worldPulse);
        }
      }
      const epoch = await worldPulse.currentEpoch();

      // Three fresh sock puppets pile into the same epoch.
      for (const sock of [mallory, m2, m3]) {
        await worldPulse.connect(sock).transfer(bob.address, ethers.parseEther("2"));
      }
      await stepOneEpoch(worldPulse);

      const honest = await worldPulse.claimableEmission(alice.address, epoch);
      let attacker = 0n;
      for (const sock of [mallory, m2, m3]) {
        attacker += await worldPulse.claimableEmission(sock.address, epoch);
      }
      // Weight is reach x (1 + streak): Alice 1 x 6, each sock 1 x 2.
      // Without the streak bonus she would have held 1 of 4 - a quarter. She
      // now holds half, from one address against three. Bounded, not solved.
      expect(honest).to.equal(EMISSION / 2n);
      // Three shares each round down independently, so this lands a couple of
      // wei under half rather than exactly on it.
      expect(attacker).to.be.lessThanOrEqual(EMISSION / 2n);
      expect(attacker).to.be.greaterThan(EMISSION / 2n - 10n);
    });
  });

  describe("Reach", function () {
    it("counts a repeated counterparty once", async function () {
      const { worldPulse, alice, bob } = await loadFixture(deployFixture);
      const epoch = await worldPulse.currentEpoch();
      for (let i = 0; i < 3; i += 1) {
        await worldPulse.connect(alice).transfer(bob.address, ethers.parseEther("2"));
      }
      expect(await worldPulse.epochBeatsOf(epoch, alice.address)).to.equal(3n, "beats still count");
      expect(await worldPulse.epochReach(epoch, alice.address)).to.equal(1n, "reach does not");
    });

    it("resets reach each epoch", async function () {
      const { worldPulse, alice, bob } = await loadFixture(deployFixture);
      const first = await worldPulse.currentEpoch();
      await worldPulse.connect(alice).transfer(bob.address, ethers.parseEther("2"));
      await nextEpoch();
      const second = await worldPulse.currentEpoch();
      await worldPulse.connect(alice).transfer(bob.address, ethers.parseEther("2"));
      expect(await worldPulse.epochReach(first, alice.address)).to.equal(1n);
      expect(await worldPulse.epochReach(second, alice.address)).to.equal(1n, "same partner counts again next epoch");
    });

    it("keeps the epoch weight equal to the sum of its parts", async function () {
      const { worldPulse, alice, bob, mallory } = await loadFixture(deployFixture);
      const epoch = await worldPulse.currentEpoch();
      await worldPulse.connect(alice).transfer(bob.address, ethers.parseEther("2"));
      await worldPulse.connect(alice).transfer(mallory.address, ethers.parseEther("2"));
      await worldPulse.connect(bob).transfer(alice.address, ethers.parseEther("2"));

      const total = await worldPulse.epochWeight(epoch);
      let sum = 0n;
      for (const who of [alice, bob, mallory]) {
        sum += await worldPulse.epochWeightOf(epoch, who.address);
      }
      expect(total).to.equal(sum, "running total must match the parts it is made of");
    });
  });

  describe("Claim rules", function () {
    it("refuses an epoch that is still open", async function () {
      const { worldPulse, alice, bob } = await loadFixture(deployFixture);
      const epoch = await worldPulse.currentEpoch();
      await worldPulse.connect(alice).transfer(bob.address, ethers.parseEther("5"));
      await expect(worldPulse.connect(alice).claimEmission(epoch)).to.be.revertedWith(
        "WorldPulse: epoch still open"
      );
    });

    it("refuses a second claim", async function () {
      const { worldPulse, alice, bob } = await loadFixture(deployFixture);
      const epoch = await worldPulse.currentEpoch();
      await worldPulse.connect(alice).transfer(bob.address, ethers.parseEther("5"));
      await nextEpoch();
      await worldPulse.connect(alice).claimEmission(epoch);
      await expect(worldPulse.connect(alice).claimEmission(epoch)).to.be.revertedWith(
        "WorldPulse: already claimed"
      );
    });

    it("refuses an address that did not beat", async function () {
      const { worldPulse, alice, bob, mallory } = await loadFixture(deployFixture);
      const epoch = await worldPulse.currentEpoch();
      await worldPulse.connect(alice).transfer(bob.address, ethers.parseEther("5"));
      await nextEpoch();
      await expect(worldPulse.connect(mallory).claimEmission(epoch)).to.be.revertedWith(
        "WorldPulse: no weight that epoch"
      );
    });

    it("rejects an emission above the cap at configuration time", async function () {
      const [owner] = await ethers.getSigners();
      const WorldPulse = await ethers.getContractFactory("WorldPulse");
      const fresh = await upgrades.deployProxy(WorldPulse, [], { initializer: "initialize" });
      await fresh.waitForDeployment();
      const tooMuch = (await fresh.MAX_EMISSION_PER_EPOCH()) + 1n;
      await expect(fresh.initializeEmission(EPOCH, tooMuch, MIN_BEAT, CAP)).to.be.revertedWith(
        "WorldPulse: emission out of range"
      );
    });
  });
});
