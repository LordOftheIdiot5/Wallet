require("@nomicfoundation/hardhat-toolbox");
require("@openzeppelin/hardhat-upgrades");
require("dotenv").config();

const networks = {
  localhost: {
    url: "http://127.0.0.1:8545",
  },
};

// Only configure Sepolia when credentials exist so compile/test work locally
// without deployment secrets.
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
