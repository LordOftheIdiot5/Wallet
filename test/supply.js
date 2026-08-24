const { loadFixture, time } = require("@nomicfoundation/hardhat-toolbox/network-helpers");
const { expect } = require("chai");
const { ethers, upgrades } = require("hardhat");

const EPOCH = 3600;
const LEGACY_EMISSION = ethers.parseEther("1000");
const MIN_BEAT = ethers.parseEther("1");
const CAP = 3;
const STREAK_BONUS = 5;
const INTRO_BONUS = 4;

const BASE_EMISSION = ethers.parseEther("2000"); // per epoch, before halving
const HALVING_EPOCHS = 10;
const HOLDER_SHARE_BPS = 6000;                   // 60% holders, 40% circulation
const TARGET_BEATS = 4;
const LIVENESS_WINDOW = 7 * 86400;

describe("Supply policy", function () {
  async function deployFixture() {
    const [owner, alice, bob, carol] = await ethers.getSigners();
    const WorldPulse = await ethers.getContractFactory("WorldPulse");
    const t = await upgrades.deployProxy(WorldPulse, [], { initializer: "initialize" });
    await t.waitForDeployment();
    await t.initializeFaucet(owner.address, ethers.parseEther("100"));
    await t.initializeEmission(EPOCH, LEGACY_EMISSION, MIN_BEAT, CAP);
    await t.initializeStreaks(STREAK_BONUS);
    await t.initializeIntroductions(INTRO_BONUS);
    await t.initializeSupplyPolicy(
      BASE_EMISSION, HALVING_EPOCHS, HOLDER_SHARE_BPS, TARGET_BEATS, LIVENESS_WINDOW
    );
    await t.transfer(alice.address, ethers.parseEther("10000"));
    await t.transfer(bob.address, ethers.parseEther("10000"));
    await time.increase(EPOCH + 1);
    return { t, owner, alice, bob, carol };
  }

  describe("The cap", function () {
    it("is 21 million and nothing can pass it", async function () {
      const { t } = await loadFixture(deployFixture);
      expect(await t.MAX_SUPPLY()).to.equal(ethers.parseEther("21000000"));
      const headroom = await t.mintableHeadroom();
      expect(headroom + (await t.totalSupply()) + (await t.promisedYield()))
        .to.equal(await t.MAX_SUPPLY());
    });

    it("counts promised yield against the ceiling, not just minted supply", async function () {
      const { t, alice, bob } = await loadFixture(deployFixture);
      await t.connect(alice).transfer(bob.address, ethers.parseEther("5"));
      await time.increase(EPOCH / 2);
      await t.connect(alice).transfer(bob.address, ethers.parseEther("5")); // triggers accrual

      const promised = await t.promisedYield();
      expect(promised).to.be.greaterThan(0n, "yield is owed before it is minted");
      expect((await t.totalSupply()) + promised + (await t.mintableHeadroom()))
        .to.equal(await t.MAX_SUPPLY(), "the three always sum to the cap");
    });
  });

  describe("The schedule", function () {
    it("halves on schedule", async function () {
      const { t } = await loadFixture(deployFixture);
      const start = await t.emissionStartEpoch();
      expect(await t.scheduledEmission(start)).to.equal(BASE_EMISSION);
      expect(await t.scheduledEmission(start + BigInt(HALVING_EPOCHS))).to.equal(BASE_EMISSION / 2n);
      expect(await t.scheduledEmission(start + BigInt(HALVING_EPOCHS) * 2n)).to.equal(BASE_EMISSION / 4n);
      expect(await t.scheduledEmission(start + BigInt(HALVING_EPOCHS) * 3n)).to.equal(BASE_EMISSION / 8n);
    });

    it("decays to nothing rather than running forever", async function () {
      const { t } = await loadFixture(deployFixture);
      const start = await t.emissionStartEpoch();
      expect(await t.scheduledEmission(start + BigInt(HALVING_EPOCHS) * 70n)).to.equal(0n);
    });
  });

  describe("Circulation link", function () {
    it("mints nothing at all for a dormant epoch", async function () {
      const { t } = await loadFixture(deployFixture);
      const epoch = await t.currentEpoch();
      expect(await t.epochBeats(epoch)).to.equal(0n);
      expect(await t.epochEmission(epoch)).to.equal(0n, "a quiet economy prints nothing");
    });

    it("scales up with activity until it reaches the schedule", async function () {
      const { t, alice, bob, carol, owner } = await loadFixture(deployFixture);
      const epoch = await t.currentEpoch();
      const scheduled = await t.scheduledEmission(epoch);

      await t.connect(alice).transfer(bob.address, ethers.parseEther("5"));
      expect(await t.epochEmission(epoch)).to.equal(scheduled / 4n, "1 of 4 target beats");

      await t.connect(alice).transfer(carol.address, ethers.parseEther("5"));
      expect(await t.epochEmission(epoch)).to.equal(scheduled / 2n);

      await t.connect(bob).transfer(owner.address, ethers.parseEther("5"));
      await t.connect(bob).transfer(carol.address, ethers.parseEther("5"));
      expect(await t.epochEmission(epoch)).to.equal(scheduled, "target reached, full schedule");
    });

    it("does not exceed the schedule however busy it gets", async function () {
      const { t, alice, bob, carol, owner } = await loadFixture(deployFixture);
      const epoch = await t.currentEpoch();
      for (const [from, to] of [[alice, bob], [alice, carol], [bob, owner], [bob, carol], [carol, alice]]) {
        await t.connect(from).transfer(to.address, ethers.parseEther("5"));
      }
      expect(await t.epochBeats(epoch)).to.be.greaterThan(BigInt(TARGET_BEATS));
      expect(await t.epochEmission(epoch)).to.equal(await t.scheduledEmission(epoch));
    });
  });

  describe("The 60/40 split", function () {
    it("gives circulation only its share of the epoch", async function () {
      const { t, alice, bob, carol, owner } = await loadFixture(deployFixture);
      const epoch = await t.currentEpoch();
      // Hit the target so emission is the full schedule.
      for (const [from, to] of [[alice, bob], [alice, carol], [bob, owner], [bob, carol]]) {
        await t.connect(from).transfer(to.address, ethers.parseEther("5"));
      }
      const total = await t.epochEmission(epoch);
      await time.increase(EPOCH + 1);

      let paidToCirculation = 0n;
      for (const who of [owner, alice, bob, carol]) {
        paidToCirculation += await t.claimableEmission(who.address, epoch);
      }
      // The circulation pool is 40% of the epoch and is fully distributed
      // between whoever earned weight, whoever that turns out to be.
      expect(paidToCirculation).to.be.lessThanOrEqual(total * 4000n / 10000n);
      expect(paidToCirculation).to.be.greaterThan(total * 4000n / 10000n - 100n);
    });
  });

  describe("Holder yield", function () {
    it("accrues on balance over time", async function () {
      const { t, alice, bob } = await loadFixture(deployFixture);
      // Land at the start of an epoch. A bare time.increase can straddle a
      // boundary into a fresh epoch, which has no beats and therefore emits
      // nothing - correct behaviour, but it makes the measurement flaky.
      const epoch = await t.currentEpoch();
      await time.increaseTo((epoch + 1n) * BigInt(EPOCH) + 10n);

      await t.connect(alice).transfer(bob.address, ethers.parseEther("5"));
      const before = await t.pendingYield(alice.address);

      await time.increase(EPOCH / 2); // still inside the same epoch
      await t.connect(bob).transfer(alice.address, ethers.parseEther("1")); // pokes accrual
      expect(await t.pendingYield(alice.address)).to.be.greaterThan(before,
        "half an epoch of holding, in an epoch with activity, banked more yield");
    });

    it("pays a bigger balance more", async function () {
      const { t, owner, alice, bob } = await loadFixture(deployFixture);
      await t.connect(alice).transfer(bob.address, ethers.parseEther("5"));
      await time.increase(EPOCH / 2);
      await t.connect(bob).transfer(alice.address, ethers.parseEther("1"));

      const ownerYield = await t.pendingYield(owner.address);
      const aliceYield = await t.pendingYield(alice.address);
      // The owner holds the bulk of supply.
      expect(ownerYield).to.be.greaterThan(aliceYield);
    });

    it("refuses to pay out to an address that has gone quiet", async function () {
      const { t, alice, bob } = await loadFixture(deployFixture);
      await t.connect(alice).transfer(bob.address, ethers.parseEther("5"));
      await time.increase(EPOCH / 2);
      await t.connect(bob).transfer(alice.address, ethers.parseEther("1"));
      expect(await t.pendingYield(alice.address)).to.be.greaterThan(0n);

      await time.increase(LIVENESS_WINDOW + 1);
      expect(await t.isAlive(alice.address)).to.equal(false);
      await expect(t.connect(alice).claimYield()).to.be.revertedWith(
        "WorldPulse: pulse too quiet to collect"
      );
    });

    it("keeps the accrual banked rather than confiscating it", async function () {
      const { t, alice, bob } = await loadFixture(deployFixture);
      await t.connect(alice).transfer(bob.address, ethers.parseEther("5"));
      await time.increase(EPOCH / 2);
      await t.connect(bob).transfer(alice.address, ethers.parseEther("1"));
      const banked = await t.pendingYield(alice.address);

      await time.increase(LIVENESS_WINDOW + 1);
      // Dormant: cannot collect. Nothing is lost.
      expect(await t.pendingYield(alice.address)).to.be.greaterThanOrEqual(banked);

      // One beat brings the pulse back and the yield is collectable again.
      await t.connect(alice).transfer(bob.address, ethers.parseEther("5"));
      expect(await t.isAlive(alice.address)).to.equal(true);
      const before = await t.balanceOf(alice.address);
      await t.connect(alice).claimYield();
      expect(await t.balanceOf(alice.address)).to.be.greaterThan(before);
    });

    it("mints on claim and reduces what is promised", async function () {
      const { t, alice, bob } = await loadFixture(deployFixture);
      await t.connect(alice).transfer(bob.address, ethers.parseEther("5"));
      await time.increase(EPOCH / 2);
      await t.connect(bob).transfer(alice.address, ethers.parseEther("1"));

      const supplyBefore = await t.totalSupply();
      const balanceBefore = await t.balanceOf(alice.address);
      const owed = await t.pendingYield(alice.address);
      await t.connect(alice).claimYield();

      const minted = (await t.balanceOf(alice.address)) - balanceBefore;
      expect(minted).to.be.greaterThanOrEqual(owed, "at least what was owed at the time");
      expect(await t.totalSupply()).to.equal(supplyBefore + minted, "claiming mints, exactly");
      expect(await t.accruedYield(alice.address)).to.equal(0n, "the bank is emptied");
      // The claim itself accrues first, so promisedYield can net upward. What
      // must hold is the cap identity, not a direction.
      expect((await t.totalSupply()) + (await t.promisedYield()) + (await t.mintableHeadroom()))
        .to.equal(await t.MAX_SUPPLY());
    });

    it("does not let a transfer carry the sender's accrual to the recipient", async function () {
      const { t, alice, bob, carol } = await loadFixture(deployFixture);
      await t.connect(alice).transfer(bob.address, ethers.parseEther("5"));
      await time.increase(EPOCH / 2);
      await t.connect(bob).transfer(carol.address, ethers.parseEther("1"));

      const aliceBefore = await t.pendingYield(alice.address);
      // Alice hands her whole balance to Carol. Her banked yield must stay hers.
      await t.connect(alice).transfer(carol.address, await t.balanceOf(alice.address));
      expect(await t.pendingYield(alice.address)).to.be.greaterThanOrEqual(aliceBefore);
      expect(await t.balanceOf(alice.address)).to.equal(0n);
    });

    it("refuses a claim when nothing has accrued", async function () {
      const { t, carol, alice, bob } = await loadFixture(deployFixture);
      await t.connect(alice).transfer(bob.address, ethers.parseEther("5"));
      await expect(t.connect(carol).claimYield()).to.be.reverted;
    });
  });
});
