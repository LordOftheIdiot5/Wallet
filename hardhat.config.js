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
  solidity: {
    version: "0.8.20",
    // The contract passed 24576 bytes once the supply policy went in, and an
    // over-size contract simply cannot be deployed. A low runs value optimises
    // for code size rather than execution cost, which is the trade this needs.
    settings: {
      optimizer: { enabled: true, runs: 1 },
    },
  },
  networks,
  // Source verification. Without it the contract shows on Etherscan as
  // bytecode, which reads as something to avoid - the code being public is
  // most of what makes a token look legitimate.
  etherscan: {
    apiKey: {
      sepolia: process.env.ETHERSCAN_API_KEY || "",
    },
  },
  sourcify: { enabled: false },
};
