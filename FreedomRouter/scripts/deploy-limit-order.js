const hre = require("hardhat");
require("dotenv").config();

const ROUTER = process.env.ROUTER_ADDRESS || "0x444444444444147c48E01D3669260E33d8b33c93";
const FEE_BPS = parseInt(process.env.FEE_BPS || "100"); // 1% default
const GAS = { gasPrice: hre.ethers.parseUnits("0.15", "gwei") };

async function main() {
  const [deployer] = await hre.ethers.getSigners();
  console.log("Deploying LimitOrderBook...\n");
  console.log("Deployer:", deployer.address);

  const balance = await hre.ethers.provider.getBalance(deployer.address);
  console.log("Balance:", hre.ethers.formatEther(balance), "BNB");
  console.log("Router:", ROUTER);
  console.log("Fee:", FEE_BPS / 100 + "%");
  console.log();

  const Factory = await hre.ethers.getContractFactory("LimitOrderBook");
  const book = await Factory.deploy(ROUTER, deployer.address, FEE_BPS, GAS);
  await book.waitForDeployment();
  const addr = await book.getAddress();
  console.log("LimitOrderBook:", addr);

  // Set deployer as executor
  console.log("Setting deployer as executor...");
  await (await book.setExecutor(deployer.address, true, GAS)).wait();
  console.log("Done");

  // Verify config
  console.log("\nConfig:");
  console.log("  router:", await book.router());
  console.log("  feeBps:", (await book.feeBps()).toString());
  console.log("  feeRecipient:", await book.feeRecipient());
  console.log("  executor[deployer]:", await book.executors(deployer.address));
  console.log("  owner:", await book.owner());

  const fs = require("fs");
  fs.writeFileSync("deployment-limit-order.json", JSON.stringify({
    contract: "LimitOrderBook",
    address: addr,
    router: ROUTER,
    feeBps: FEE_BPS,
    feeRecipient: deployer.address,
    deployer: deployer.address,
    timestamp: new Date().toISOString(),
  }, null, 2));

  console.log("\nSaved to deployment-limit-order.json");
}

main()
  .then(() => process.exit(0))
  .catch(console.error);
