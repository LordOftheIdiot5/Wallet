const { loadFixture, time } = require("@nomicfoundation/hardhat-toolbox/network-helpers");
const { expect } = require("chai");
const { ethers, upgrades } = require("hardhat");

const MIN_DELAY = 15 * 60;          // everyone waits a little
const LARGE_SHARE_DELAY = 6 * 3600; // draining most of the vault
const DORMANCY_DELAY = 24 * 3600;   // silent address suddenly moving
const DORMANCY_WINDOW = 30 * 86400;
const MAX_DELAY = 3 * 86400;
const GUARDIAN_DELAY = 2 * 86400;

const DEPOSIT = ethers.parseEther("1000");

describe("PulseVault", function () {
  async function deployFixture() {
    const [owner, alice, guardian, thief, stranger] = await ethers.getSigners();
    const WorldPulse = await ethers.getContractFactory("WorldPulse");
    const token = await upgrades.deployProxy(WorldPulse, [], { initializer: "initialize" });
    await token.waitForDeployment();

    const vault = await ethers.deployContract("PulseVault", [
      await token.getAddress(),
      await token.getAddress(),
      MIN_DELAY, LARGE_SHARE_DELAY, DORMANCY_DELAY, DORMANCY_WINDOW, MAX_DELAY, GUARDIAN_DELAY,
    ]);
    await vault.waitForDeployment();

    await token.transfer(alice.address, ethers.parseEther("5000"));
    await token.connect(alice).approve(await vault.getAddress(), ethers.parseEther("5000"));
    await vault.connect(alice).deposit(DEPOSIT);
    await vault.connect(alice).setGuardian(guardian.address);

    return { token, vault, owner, alice, guardian, thief, stranger };
  }

  describe("What it refuses to do", function () {
    it("gives a hostile guardian no way to take funds", async function () {
      const { vault, token, alice, guardian } = await loadFixture(deployFixture);
      await vault.connect(alice).requestWithdraw(alice.address, ethers.parseEther("10"));

      // A guardian cannot withdraw, cannot request, cannot redirect.
      await expect(vault.connect(guardian).executeWithdraw()).to.be.revertedWith(
        "PulseVault: nothing pending"
      );
      await expect(
        vault.connect(guardian).requestWithdraw(guardian.address, ethers.parseEther("10"))
      ).to.be.revertedWith("PulseVault: amount exceeds balance");

      // All they can do is cancel, and cancelling pays them nothing.
      const before = await token.balanceOf(guardian.address);
      await vault.connect(guardian).cancelWithdraw(alice.address);
      expect(await token.balanceOf(guardian.address)).to.equal(before, "cancelling pays nobody");
      expect(await vault.balanceOf(alice.address)).to.equal(DEPOSIT, "funds stay with the depositor");
    });

    it("stops a guardian holding a depositor hostage forever", async function () {
      const { vault, alice, guardian, stranger } = await loadFixture(deployFixture);

      // Guardian turns hostile and cancels everything.
      await vault.connect(alice).requestWithdraw(alice.address, ethers.parseEther("10"));
      await vault.connect(guardian).cancelWithdraw(alice.address);

      // Alice starts replacing them. The guardian must not be able to stop this.
      await vault.connect(alice).setGuardian(stranger.address);
      await expect(vault.connect(guardian).cancelGuardianChange()).to.be.revertedWith(
        "PulseVault: no change pending"
      );

      await time.increase(GUARDIAN_DELAY + 1);
      await vault.connect(alice).executeGuardianChange();
      expect(await vault.guardianOf(alice.address)).to.equal(stranger.address);

      // The old guardian is now powerless.
      await vault.connect(alice).requestWithdraw(alice.address, ethers.parseEther("10"));
      await expect(vault.connect(guardian).cancelWithdraw(alice.address)).to.be.revertedWith(
        "PulseVault: not owner or guardian"
      );
    });

    it("refuses a stranger any influence at all", async function () {
      const { vault, alice, stranger } = await loadFixture(deployFixture);
      await vault.connect(alice).requestWithdraw(alice.address, ethers.parseEther("10"));
      await expect(vault.connect(stranger).cancelWithdraw(alice.address)).to.be.revertedWith(
        "PulseVault: not owner or guardian"
      );
      await expect(
        vault.connect(stranger).requestWithdraw(stranger.address, 1n)
      ).to.be.revertedWith("PulseVault: amount exceeds balance");
    });

    it("has no admin able to touch anyone's deposit", async function () {
      const { vault, owner, alice } = await loadFixture(deployFixture);
      // The deployer is just another address here.
      await expect(vault.connect(owner).cancelWithdraw(alice.address)).to.be.revertedWith(
        "PulseVault: not owner or guardian"
      );
      expect(await vault.balanceOf(owner.address)).to.equal(0n);
      // And there is no privileged function to find - the ABI has no owner role.
      const names = vault.interface.fragments
        .filter((f) => f.type === "function")
        .map((f) => f.name);
      expect(names).to.not.include.members(["owner", "transferOwnership", "pause", "seize", "sweep"]);
    });

    it("will not release a withdrawal early", async function () {
      const { vault, alice } = await loadFixture(deployFixture);
      await vault.connect(alice).requestWithdraw(alice.address, ethers.parseEther("10"));
      await expect(vault.connect(alice).executeWithdraw()).to.be.revertedWith(
        "PulseVault: still waiting"
      );
    });

    it("will not let anyone withdraw more than they put in", async function () {
      const { vault, alice } = await loadFixture(deployFixture);
      await expect(
        vault.connect(alice).requestWithdraw(alice.address, DEPOSIT + 1n)
      ).to.be.revertedWith("PulseVault: amount exceeds balance");
    });
  });

  describe("A thief with the key", function () {
    it("cannot outrun a watching guardian", async function () {
      const { vault, token, alice, guardian, thief } = await loadFixture(deployFixture);
      // The thief has Alice's key, so they act as Alice.
      for (let attempt = 0; attempt < 3; attempt += 1) {
        await vault.connect(alice).requestWithdraw(thief.address, DEPOSIT);
        await vault.connect(guardian).cancelWithdraw(alice.address);
      }
      expect(await token.balanceOf(thief.address)).to.equal(0n);
      expect(await vault.balanceOf(alice.address)).to.equal(DEPOSIT, "nothing got out");
    });

    it("waits longest for exactly the pattern a drain makes", async function () {
      const { vault, alice } = await loadFixture(deployFixture);
      // Depositing is itself a transfer, so it counts as a beat and leaves the
      // address looking alive. Go quiet first to get the drain signature.
      await time.increase(DORMANCY_WINDOW + 1);

      const drain = await vault.delayFor(alice.address, DEPOSIT);
      const small = await vault.delayFor(alice.address, ethers.parseEther("1"));
      expect(drain).to.be.greaterThan(small);
      // Full share penalty plus the dormancy penalty, still inside the ceiling.
      expect(drain).to.equal(BigInt(MIN_DELAY + LARGE_SHARE_DELAY + DORMANCY_DELAY));
      expect(drain).to.be.lessThanOrEqual(BigInt(MAX_DELAY));
      // A small amount from the same dormant address pays almost no share penalty.
      expect(small).to.be.lessThan(BigInt(MIN_DELAY + DORMANCY_DELAY) + 60n);
    });

    it("gains nothing by splitting the drain into slices", async function () {
      const { vault, alice } = await loadFixture(deployFixture);
      const whole = await vault.delayFor(alice.address, DEPOSIT);
      const slice = await vault.delayFor(alice.address, DEPOSIT / 10n);

      // A slice waits less individually...
      expect(slice).to.be.lessThan(whole);
      // ...but the share penalty is proportional, so ten slices carry the same
      // penalty in total plus ten minimum waits. Only one withdrawal can be
      // pending at a time, so that total is what the thief actually pays.
      expect(slice * 10n).to.be.greaterThan(whole);
      expect(slice * 10n - whole).to.equal(BigInt(MIN_DELAY) * 9n, "exactly nine extra minimums");

      await vault.connect(alice).requestWithdraw(alice.address, DEPOSIT / 10n);
      await expect(
        vault.connect(alice).requestWithdraw(alice.address, DEPOSIT / 10n)
      ).to.be.revertedWith("PulseVault: withdrawal already pending");
    });

    it("cannot swap the guardian out instantly", async function () {
      const { vault, alice, thief } = await loadFixture(deployFixture);
      await vault.connect(alice).setGuardian(thief.address);
      // Still the original guardian until the timelock elapses.
      expect(await vault.guardianOf(alice.address)).to.not.equal(thief.address);
      await expect(vault.connect(alice).executeGuardianChange()).to.be.revertedWith(
        "PulseVault: still waiting"
      );
    });
  });

  describe("Ordinary use", function () {
    it("lets a depositor withdraw after the wait", async function () {
      const { vault, token, alice } = await loadFixture(deployFixture);
      const amount = ethers.parseEther("10");
      const before = await token.balanceOf(alice.address);

      await vault.connect(alice).requestWithdraw(alice.address, amount);
      await time.increase(MAX_DELAY + 1);
      await vault.connect(alice).executeWithdraw();

      expect(await token.balanceOf(alice.address)).to.equal(before + amount);
      expect(await vault.balanceOf(alice.address)).to.equal(DEPOSIT - amount);
    });

    it("barely delays someone who is beating regularly", async function () {
      const { vault, token, alice, stranger } = await loadFixture(deployFixture);
      // A recent beat means the address is not dormant.
      await token.connect(alice).transfer(stranger.address, ethers.parseEther("1"));
      const delay = await vault.delayFor(alice.address, ethers.parseEther("1"));
      // Minimum wait plus a share penalty proportional to 0.1% of the vault,
      // which is a handful of seconds. Ordinary use is effectively unaffected.
      expect(delay).to.be.greaterThanOrEqual(BigInt(MIN_DELAY));
      expect(delay).to.be.lessThan(BigInt(MIN_DELAY) + 60n, "in rhythm: barely a wait");
    });

    it("never delays beyond the ceiling", async function () {
      const { vault, alice } = await loadFixture(deployFixture);
      expect(await vault.delayFor(alice.address, DEPOSIT)).to.be.lessThanOrEqual(BigInt(MAX_DELAY));
    });

    it("lets the depositor cancel their own withdrawal", async function () {
      const { vault, alice } = await loadFixture(deployFixture);
      await vault.connect(alice).requestWithdraw(alice.address, ethers.parseEther("10"));
      await vault.connect(alice).cancelWithdraw(alice.address);
      expect((await vault.pendingOf(alice.address)).amount).to.equal(0n);
      expect(await vault.balanceOf(alice.address)).to.equal(DEPOSIT);
    });
  });
});
