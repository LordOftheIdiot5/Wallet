// Renders a real address's pulse from live Sepolia state and writes the SVG to
// disk, so the image can be looked at rather than only asserted about.
//
//   npx hardhat run scripts/render-pulse.js
const fs = require("fs");
const path = require("path");
const { ethers, network } = require("hardhat");

const FORK_RPC = process.env.FORK_RPC_URL || "https://ethereum-sepolia-rpc.publicnode.com";
const PROXY = "0x53911907277be8f6E6B2d3D63A5796410EfA5A0e";
const SUBJECT = process.env.SUBJECT || "0x8cA1470b3Ea971ADD119aDA2271e84bDBfccEA2A";

async function main() {
  const live = new ethers.JsonRpcProvider(FORK_RPC);
  const head = await live.getBlockNumber();
  live.destroy();
  await network.provider.request({
    method: "hardhat_reset",
    params: [{ forking: { jsonRpcUrl: FORK_RPC, blockNumber: head - 2 } }],
  });

  const renderer = await ethers.deployContract("PulseRenderer", [PROXY]);
  await renderer.waitForDeployment();

  const [bpm, state, beats, sinceLast] = await renderer.readingOf(SUBJECT);
  console.log("Subject :", SUBJECT);
  console.log("Reading :", `${bpm} BPM · ${state} · ${beats} beats · last ${sinceLast}s ago`);

  const svg = await renderer.renderSVG(SUBJECT);
  const out = path.join(__dirname, "..", "wallet", "pulse-sample.svg");
  fs.writeFileSync(out, svg);
  console.log("Wrote   :", out, `(${svg.length} bytes)`);

  const uri = await renderer.renderDataURI(SUBJECT);
  console.log("DataURI :", uri.length, "bytes");

  await network.provider.request({ method: "hardhat_reset", params: [] });
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
