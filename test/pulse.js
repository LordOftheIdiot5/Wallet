const { expect } = require("chai");
const { computePulse } = require("../wallet/pulse.js");

const NOW = 1_800_000_000;

describe("Pulse math", function () {
  it("is dormant when an address has never moved WPU", function () {
    const pulse = computePulse({ now: NOW, balance: 100, movements: [], networkBeats: 0 });
    expect(pulse.state).to.equal("dormant");
    expect(pulse.bpm).to.equal(48);
    expect(pulse.personalBeats).to.equal(0);
    expect(pulse.suggestion).to.match(/No pulse yet/);
  });

  it("is still when WPU was received but never sent", function () {
    const pulse = computePulse({
      now: NOW,
      balance: 80,
      movements: [{ direction: "received", amount: 80, timestamp: NOW - 3600 }],
      networkBeats: 3,
    });
    expect(pulse.state).to.equal("still");
    expect(pulse.bpm).to.equal(56);
  });

  it("is steady when sends are small relative to holdings", function () {
    const pulse = computePulse({
      now: NOW,
      balance: 999810,
      networkBeats: 6,
      movements: [
        { direction: "sent", amount: 100, timestamp: NOW - 10 * 86400 },
        { direction: "sent", amount: 60, timestamp: NOW - 8 * 86400 },
        { direction: "sent", amount: 30, timestamp: NOW - 2 * 86400 },
      ],
    });
    expect(pulse.state).to.equal("steady");
    expect(pulse.personalBeats).to.equal(3);
    expect(pulse.runwayDays).to.be.greaterThan(1000);
    expect(pulse.suggestion).to.match(/Steady pulse/);
  });

  it("is racing when a large share of WPU has already been sent", function () {
    const pulse = computePulse({
      now: NOW,
      balance: 20,
      networkBeats: 4,
      movements: [
        { direction: "sent", amount: 40, timestamp: NOW - 3 * 86400 },
        { direction: "sent", amount: 40, timestamp: NOW - 3600 },
      ],
    });
    expect(pulse.state).to.equal("racing");
    expect(pulse.bpm).to.be.at.least(96);
    expect(pulse.suggestion).to.match(/racing/i);
  });

  it("goes dormant after two weeks without a beat", function () {
    const pulse = computePulse({
      now: NOW,
      balance: 500,
      movements: [{ direction: "sent", amount: 10, timestamp: NOW - 20 * 86400 }],
    });
    expect(pulse.state).to.equal("dormant");
    expect(pulse.daysSinceLast).to.be.closeTo(20, 0.01);
  });
});
