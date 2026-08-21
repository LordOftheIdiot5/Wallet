const fs = require("fs");
const path = require("path");
const { expect } = require("chai");
const { ethers } = require("hardhat");

// A method missing from the wallet's ABI throws synchronously, before any
// promise exists, so the usual .catch() guards never run and the whole card
// dies. That shipped once. This checks the two things that must agree:
// what app.js calls, what the ABI declares, and what the contract implements.
describe("Wallet ABI", function () {
  const source = fs.readFileSync(
    path.join(__dirname, "..", "wallet", "app.js"),
    "utf8"
  );

  // ethers' own surface, not contract methods.
  const NOT_CONTRACT_CALLS = new Set([
    "queryFilter",
    "filters",
    "on",
    "connect",
    "interface",
    "getAddress",
    "waitForDeployment",
    "wait",
    "catch",
    "then",
    "getFunction",
    "target",
  ]);

  function declaredAbi() {
    const match = source.match(/const ABI = \[([\s\S]*?)\n\];/);
    expect(match, "could not find the ABI array in app.js").to.not.equal(null);
    return match[1]
      .split("\n")
      .map((line) => line.trim().replace(/^"/, "").replace(/",?$/, ""))
      .filter((line) => line.startsWith("function ") || line.startsWith("event "));
  }

  function calledMethods() {
    const found = new Set();
    // contract.foo(  /  netContract.foo(  /  token.foo(
    const re = /\b(?:net)?[Cc]ontract\.([A-Za-z_]\w*)\s*\(/g;
    let m;
    while ((m = re.exec(source)) !== null) {
      if (!NOT_CONTRACT_CALLS.has(m[1])) {
        found.add(m[1]);
      }
    }
    return [...found].sort();
  }

  it("declares every method app.js calls", function () {
    const iface = new ethers.Interface(declaredAbi());
    const missing = calledMethods().filter((name) => {
      try {
        return iface.getFunction(name) === null;
      } catch {
        return true;
      }
    });
    expect(missing, `app.js calls these but the ABI omits them: ${missing.join(", ")}`)
      .to.deep.equal([]);
  });

  it("declares nothing the contract does not implement", function () {
    const walletAbi = new ethers.Interface(declaredAbi());
    const contractAbi = new ethers.Interface(
      require("../artifacts/contracts/WorldPulse.sol/WorldPulse.json").abi
    );
    const unknown = [];
    walletAbi.forEachFunction((fragment) => {
      if (contractAbi.getFunction(fragment.format("sighash")) === null) {
        unknown.push(fragment.format("sighash"));
      }
    });
    expect(unknown, `the wallet declares functions WorldPulse does not have: ${unknown.join(", ")}`)
      .to.deep.equal([]);
  });
});
