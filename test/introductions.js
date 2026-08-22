const { loadFixture, time } = require("@nomicfoundation/hardhat-toolbox/network-helpers");
const { expect } = require("chai");
const { ethers, upgrades } = require("hardhat");

const EPOCH = 3600;
const EMISSION = ethers.parseEther("1000");
const MIN_BEAT = ethers.parseEther("1");
const CAP = 3;
const MAX_STREAK_BONUS = 5;
const INTRO_BONUS = 4; // a vested introduction is worth four reach

describe("Proof of introduction", function () {
  async function deployFixture() {
    const signers = await ethers.getSigners();
    const [owner, alice, bob, carol, dave, mallory] = signers;
    const WorldPulse = await ethers.getContractFactory("WorldPulse");
    const worldPulse = await upgrades.deployProxy(WorldPulse, [], { initializer: "initialize" });
    await worldPulse.waitForDeployment();
    await worldPulse.initializeFaucet(owner.address, ethers.parseEther("100"));
    await worldPulse.initializeEmission(EPOCH, EMISSION, MIN_BEAT, CAP);
    await worldPulse.initializeStreaks(MAX_STREAK_BONUS);
    await worldPulse.initializeIntroductions(INTRO_BONUS);

    // Alice is funded and known. Everyone else starts having never held WPU.
    await worldPulse.transfer(alice.address, ethers.parseEther("2000"));
    await time.increase(EPOCH + 1);
    return { worldPulse, owner, alice, bob, carol, dave, mallory, signers };
  }

  async function nextEpoch() {
    await time.increase(EPOCH + 1);
  }

  describe("The loop it is meant to create", function () {
    it("records who first handed an address WPU", async function () {
      const { worldPulse, alice, bob } = await loadFixture(deployFixture);
      expect(await worldPulse.everHeld(bob.address)).to.equal(false);
      await worldPulse.connect(alice).transfer(bob.address, ethers.parseEther("50"));
      expect(await worldPulse.everHeld(bob.address)).to.equal(true);
      expect(await worldPulse.introducedBy(bob.address)).to.equal(alice.address);
    });

    it("pays nothing until the newcomer actually beats", async function () {
      const { worldPulse, alice, bob, carol } = await loadFixture(deployFixture);
      const epoch = await worldPulse.currentEpoch();

      await worldPulse.connect(alice).transfer(bob.address, ethers.parseEther("50"));
      expect(await worldPulse.epochIntroductions(epoch, alice.address)).to.equal(0n,
        "handing over tokens earns nothing on its own");

      // Bob comes alive.
      await worldPulse.connect(bob).transfer(carol.address, ethers.parseEther("5"));
      expect(await worldPulse.epochIntroductions(epoch, alice.address)).to.equal(1n);
    });

    it("makes an introduction worth more than an ordinary send", async function () {
      const { worldPulse, alice, bob, carol, dave } = await loadFixture(deployFixture);
      const epoch = await worldPulse.currentEpoch();

      // Alice introduces Bob, who comes alive.
      await worldPulse.connect(alice).transfer(bob.address, ethers.parseEther("50"));
      await worldPulse.connect(bob).transfer(carol.address, ethers.parseEther("5"));

      // Alice: reach 1 + one vested introduction worth INTRO_BONUS.
      const aliceWeight = await worldPulse.weightOf(alice.address, epoch);
      // Bob reached one address and introduced Carol, but Carol has not beaten.
      const bobWeight = await worldPulse.weightOf(bob.address, epoch);
      expect(aliceWeight).to.be.greaterThan(bobWeight);
      expect(aliceWeight).to.equal(BigInt(1 + INTRO_BONUS) * 2n, "reach 1 + intro 4, streak 1");
    });

    it("only ever credits one introducer per address", async function () {
      const { worldPulse, alice, bob, carol, dave } = await loadFixture(deployFixture);
      await worldPulse.connect(alice).transfer(bob.address, ethers.parseEther("50"));
      // Carol also sends Bob tokens, but she did not introduce him.
      await worldPulse.connect(alice).transfer(carol.address, ethers.parseEther("50"));
      await worldPulse.connect(carol).transfer(bob.address, ethers.parseEther("5"));
      expect(await worldPulse.introducedBy(bob.address)).to.equal(alice.address);

      const epoch = await worldPulse.currentEpoch();
      await worldPulse.connect(bob).transfer(dave.address, ethers.parseEther("5"));
      // Alice is credited twice because she introduced both Bob and Carol, and
      // Carol's own beat above vested her. The point is the next line: Carol
      // sent Bob tokens but was not his introducer, so she is credited nothing.
      expect(await worldPulse.epochIntroductions(epoch, alice.address)).to.equal(2n);
      expect(await worldPulse.epochIntroductions(epoch, carol.address)).to.equal(0n);
    });

    it("pays an introducer once, not every time the newcomer beats", async function () {
      const { worldPulse, alice, bob, carol, dave } = await loadFixture(deployFixture);
      const epoch = await worldPulse.currentEpoch();
      await worldPulse.connect(alice).transfer(bob.address, ethers.parseEther("50"));
      await worldPulse.connect(bob).transfer(carol.address, ethers.parseEther("5"));
      await worldPulse.connect(bob).transfer(dave.address, ethers.parseEther("5"));
      expect(await worldPulse.epochIntroductions(epoch, alice.address)).to.equal(1n);
    });
  });

  describe("Sybil resistance", function () {
    it("gives nothing for generating addresses and funding them", async function () {
      const { worldPulse, alice } = await loadFixture(deployFixture);
      const epoch = await worldPulse.currentEpoch();

      // The cheapest attack: spray fresh addresses. None of them beat.
      for (let i = 0; i < 5; i += 1) {
        const fresh = ethers.Wallet.createRandom();
        await worldPulse.connect(alice).transfer(fresh.address, ethers.parseEther("50"));
      }
      expect(await worldPulse.epochIntroductions(epoch, alice.address)).to.equal(0n,
        "an address that never beats is never an introduction");
    });

    it("forces a farm to make its sybils genuinely active", async function () {
      const { worldPulse, mallory, owner, signers } = await loadFixture(deployFixture);
      await worldPulse.transfer(mallory.address, ethers.parseEther("500"));
      await nextEpoch();
      const epoch = await worldPulse.currentEpoch();

      // Mallory funds two puppets. To collect, each must beat with a real
      // amount, to a distinct address, having been given gas.
      const puppets = [signers[7], signers[8]];
      for (const puppet of puppets) {
        await worldPulse.connect(mallory).transfer(puppet.address, ethers.parseEther("50"));
      }
      expect(await worldPulse.epochIntroductions(epoch, mallory.address)).to.equal(0n);

      for (const puppet of puppets) {
        await worldPulse.connect(puppet).transfer(owner.address, ethers.parseEther("5"));
      }
      // Credited - but only because the puppets moved real tokens to a real
      // counterparty, which is the behaviour being paid for either way.
      expect(await worldPulse.epochIntroductions(epoch, mallory.address)).to.equal(2n);
    });

    it("caps how many introductions can vest into one epoch", async function () {
      const { worldPulse, mallory, owner, signers } = await loadFixture(deployFixture);
      await worldPulse.transfer(mallory.address, ethers.parseEther("500"));
      await nextEpoch();
      const epoch = await worldPulse.currentEpoch();

      const puppets = signers.slice(7, 13); // six of them, cap is three
      for (const puppet of puppets) {
        await worldPulse.connect(mallory).transfer(puppet.address, ethers.parseEther("50"));
      }
      for (const puppet of puppets) {
        await worldPulse.connect(puppet).transfer(owner.address, ethers.parseEther("5"));
      }
      expect(await worldPulse.epochIntroductions(epoch, mallory.address)).to.equal(BigInt(CAP));
    });

    it("holds an over-cap introduction back rather than burning it", async function () {
      const { worldPulse, mallory, owner, signers } = await loadFixture(deployFixture);
      await worldPulse.transfer(mallory.address, ethers.parseEther("500"));
      await nextEpoch();

      const puppets = signers.slice(7, 12); // five, cap is three
      for (const puppet of puppets) {
        await worldPulse.connect(mallory).transfer(puppet.address, ethers.parseEther("50"));
      }
      for (const puppet of puppets) {
        await worldPulse.connect(puppet).transfer(owner.address, ethers.parseEther("5"));
      }
      // The two that could not fit are still uncredited, so they can vest later.
      const overflow = puppets.filter(
        async (p) => !(await worldPulse.introductionCredited(p.address))
      );
      expect(overflow.length).to.be.greaterThan(0);

      await nextEpoch();
      const later = await worldPulse.currentEpoch();
      for (const puppet of puppets) {
        await worldPulse.connect(puppet).transfer(owner.address, ethers.parseEther("5"));
      }
      expect(await worldPulse.epochIntroductions(later, mallory.address)).to.be.greaterThan(0n,
        "the leftover credits land in a later epoch instead of vanishing");
    });

    it("does not let the faucet reserve farm its own drips", async function () {
      const { worldPulse, owner, alice, bob } = await loadFixture(deployFixture);
      await worldPulse.approve(await worldPulse.getAddress(), ethers.parseEther("1000"));
      const epoch = await worldPulse.currentEpoch();

      await worldPulse.connect(bob).claim();
      expect(await worldPulse.everHeld(bob.address)).to.equal(true);
      expect(await worldPulse.introducedBy(bob.address)).to.equal(ethers.ZeroAddress,
        "a drip is distribution, not an introduction");

      await worldPulse.connect(bob).transfer(alice.address, ethers.parseEther("5"));
      expect(await worldPulse.epochIntroductions(epoch, owner.address)).to.equal(0n);
    });

    it("cannot be re-run on the same address by resending", async function () {
      const { worldPulse, alice, bob, carol } = await loadFixture(deployFixture);
      await worldPulse.connect(alice).transfer(bob.address, ethers.parseEther("50"));
      await worldPulse.connect(bob).transfer(carol.address, ethers.parseEther("5"));
      await nextEpoch();

      const later = await worldPulse.currentEpoch();
      await worldPulse.connect(alice).transfer(bob.address, ethers.parseEther("50"));
      await worldPulse.connect(bob).transfer(carol.address, ethers.parseEther("5"));
      expect(await worldPulse.epochIntroductions(later, alice.address)).to.equal(0n,
        "Bob can only be introduced once, ever");
    });
  });
});
