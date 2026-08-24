const { loadFixture, time } = require("@nomicfoundation/hardhat-toolbox/network-helpers");
const { expect } = require("chai");
const { ethers, upgrades } = require("hardhat");

const EPOCH = 3600;

describe("PulseRenderer", function () {
  async function deployFixture() {
    const [owner, alice, bob] = await ethers.getSigners();
    const WorldPulse = await ethers.getContractFactory("WorldPulse");
    const worldPulse = await upgrades.deployProxy(WorldPulse, [], { initializer: "initialize" });
    await worldPulse.waitForDeployment();
    await worldPulse.initializeFaucet(owner.address, ethers.parseEther("100"));
    await worldPulse.initializeEmission(EPOCH, ethers.parseEther("1000"), ethers.parseEther("1"), 3);
    await worldPulse.initializeStreaks(5);
    await worldPulse.transfer(alice.address, ethers.parseEther("1000"));

    const renderer = await ethers.deployContract("PulseRenderer", [await worldPulse.getAddress()]);
    await renderer.waitForDeployment();
    return { worldPulse, renderer, owner, alice, bob };
  }

  it("reads dormant for an address that has never sent", async function () {
    const { renderer, bob } = await loadFixture(deployFixture);
    const [bpm, state, beats] = await renderer.readingOf(bob.address);
    expect(state).to.equal("dormant");
    expect(bpm).to.equal(48n);
    expect(beats).to.equal(0n);
  });

  it("reads steady straight after a beat", async function () {
    const { worldPulse, renderer, alice, bob } = await loadFixture(deployFixture);
    await worldPulse.connect(alice).transfer(bob.address, ethers.parseEther("5"));
    const [bpm, state] = await renderer.readingOf(alice.address);
    expect(state).to.equal("steady");
    expect(bpm).to.be.greaterThan(48n);
  });

  it("goes quiet as time passes", async function () {
    const { worldPulse, renderer, alice, bob } = await loadFixture(deployFixture);
    await worldPulse.connect(alice).transfer(bob.address, ethers.parseEther("5"));

    await time.increase(3 * 86400);
    expect((await renderer.readingOf(alice.address))[1]).to.equal("still");

    await time.increase(15 * 86400);
    expect((await renderer.readingOf(alice.address))[1]).to.equal("dormant");
  });

  it("beats faster with a longer streak", async function () {
    const { worldPulse, renderer, alice, bob } = await loadFixture(deployFixture);
    await worldPulse.connect(alice).transfer(bob.address, ethers.parseEther("2"));
    const [slow] = await renderer.readingOf(alice.address);

    for (let i = 0; i < 4; i += 1) {
      const epoch = await worldPulse.currentEpoch();
      await time.increaseTo((epoch + 1n) * BigInt(EPOCH) + 5n);
      await worldPulse.connect(alice).transfer(bob.address, ethers.parseEther("2"));
    }
    const [fast] = await renderer.readingOf(alice.address);
    expect(fast).to.be.greaterThan(slow, "rhythm shows up in the reading");
  });

  it("renders SVG that is actually well formed", async function () {
    const { worldPulse, renderer, alice, bob } = await loadFixture(deployFixture);
    await worldPulse.connect(alice).transfer(bob.address, ethers.parseEther("5"));
    const svg = await renderer.renderSVG(alice.address);

    expect(svg.startsWith("<svg")).to.equal(true);
    expect(svg.endsWith("</svg>")).to.equal(true);
    expect(svg).to.include('viewBox="0 0 600 200"');
    expect(svg).to.include("<polyline");
    expect(svg).to.include("BPM");
    // Tags must balance, or it will not render in an <img>.
    const opens = (svg.match(/</g) || []).length;
    const closes = (svg.match(/>/g) || []).length;
    expect(opens).to.equal(closes);
  });

  it("puts a shortened address in the image", async function () {
    const { renderer, alice } = await loadFixture(deployFixture);
    const svg = await renderer.renderSVG(alice.address);
    const lower = alice.address.toLowerCase();
    expect(svg).to.include(lower.slice(0, 6));
    expect(svg).to.include(lower.slice(-4));
  });

  it("colours the trace by state", async function () {
    const { worldPulse, renderer, alice, bob } = await loadFixture(deployFixture);
    expect(await renderer.renderSVG(bob.address)).to.include("#8ea0c4"); // dormant
    await worldPulse.connect(alice).transfer(bob.address, ethers.parseEther("5"));
    expect(await renderer.renderSVG(alice.address)).to.include("#3ee0c5"); // steady
  });

  it("beats at the address's own rate", async function () {
    const { worldPulse, renderer, alice, bob } = await loadFixture(deployFixture);
    await worldPulse.connect(alice).transfer(bob.address, ethers.parseEther("5"));
    const [bpm] = await renderer.readingOf(alice.address);
    const svg = await renderer.renderSVG(alice.address);

    // SMIL animates inside an <img>, where CSS does not.
    expect(svg).to.include("<animate");
    expect(svg).to.include('repeatCount="indefinite"');
    // One beat period, derived from the on-chain reading.
    const period = `dur="${60000n / bpm}ms"`;
    expect(svg).to.include(period);
  });

  it("beats faster on screen when the pulse is faster", async function () {
    const { worldPulse, renderer, alice, bob } = await loadFixture(deployFixture);
    const dormant = await renderer.renderSVG(bob.address);
    await worldPulse.connect(alice).transfer(bob.address, ethers.parseEther("5"));
    const alive = await renderer.renderSVG(alice.address);

    const durOf = (svg) => Number(svg.match(/dur="(\d+)ms"/)[1]);
    expect(durOf(alive)).to.be.lessThan(durOf(dormant), "higher BPM, shorter period");
  });

  it("produces a data URI an <img> can load", async function () {
    const { renderer, alice } = await loadFixture(deployFixture);
    const uri = await renderer.renderDataURI(alice.address);
    expect(uri.startsWith("data:image/svg+xml;base64,")).to.equal(true);
    const decoded = Buffer.from(uri.split(",")[1], "base64").toString("utf8");
    expect(decoded.startsWith("<svg")).to.equal(true);
    expect(decoded.endsWith("</svg>")).to.equal(true);
  });
});
