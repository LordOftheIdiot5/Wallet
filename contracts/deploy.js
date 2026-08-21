const fs = require("fs");
const path = require("path");
const { ethers, upgrades } = require("hardhat");

async function main() {
  const WorldPulse = await ethers.getContractFactory("WorldPulse");
  const worldPulse = await upgrades.deployProxy(WorldPulse, [], { initializer: "initialize" });
  await worldPulse.waitForDeployment();
  const address = await worldPulse.getAddress();
  const network = await ethers.provider.getNetwork();
  console.log("WorldPulse deployed to:", address);

  if (network.chainId === 31337n) {
    const [sender, recipient] = await ethers.getSigners();
    const config = {
      contract: address,
      chainId: "31337",
      rpc: "http://127.0.0.1:8546",
      sender: sender.address,
      recipient: recipient.address,
    };
    const out = path.join(__dirname, "../wallet/demo-config.json");
    fs.writeFileSync(out, JSON.stringify(config, null, 2));
    console.log("Wrote", out);
  }
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
