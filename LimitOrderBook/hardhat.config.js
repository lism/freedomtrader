require("@nomicfoundation/hardhat-toolbox");
require("dotenv").config();

const forkUrl = process.env.BSC_RPC_URL;
const forkBlockNumber = process.env.BSC_FORK_BLOCK
  ? Number(process.env.BSC_FORK_BLOCK)
  : undefined;

const hardhatNetwork = forkUrl
  ? {
      forking: {
        url: forkUrl,
        ...(forkBlockNumber ? { blockNumber: forkBlockNumber } : {})
      }
    }
  : {};

/** @type import('hardhat/config').HardhatUserConfig */
module.exports = {
  solidity: {
    version: "0.8.28",
    settings: {
      evmVersion: "cancun",
      optimizer: {
        enabled: true,
        runs: 200
      }
    }
  },
  networks: {
    hardhat: hardhatNetwork,
    bsc: {
      url: process.env.BSC_RPC_URL || "https://bsc-dataseed1.binance.org",
      accounts: process.env.PRIVATE_KEY ? [process.env.PRIVATE_KEY] : [],
      gasPrice: 80000000,
      chainId: 56
    },
    bscTestnet: {
      url: "https://data-seed-prebsc-1-s1.binance.org:8545",
      accounts: process.env.PRIVATE_KEY ? [process.env.PRIVATE_KEY] : [],
      chainId: 97
    }
  },
  etherscan: {
    apiKey: process.env.BSCSCAN_API_KEY || "",
    customChains: [
      {
        network: "bsc",
        chainId: 56,
        urls: {
          apiURL: "https://api.bscscan.com/v2/api",
          browserURL: "https://bscscan.com"
        }
      }
    ]
  }
};
