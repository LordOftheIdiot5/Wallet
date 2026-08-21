require("@nomicfoundation/hardhat-toolbox");
require("@openzeppelin/hardhat-upgrades");
require("dotenv").config();

const networks = {};

// Only configure the Sepolia network when its credentials are provided, so
// local tasks (compile, test on the in-process Hardhat network) work without
// requiring deployment secrets.
if (process.env.SEPOLIA_RPC_URL && process.env.PRIVATE_KEY) {
  networks.sepolia = {
    url: process.env.SEPOLIA_RPC_URL,
    accounts: [process.env.PRIVATE_KEY],
  };
}

module.exports = {
  solidity: "0.8.20",
  networks,
};