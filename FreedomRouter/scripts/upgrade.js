const hre = require("hardhat");
require("dotenv").config();

const PROXY = process.env.PROXY_ADDRESS || "0x444444444444147c48E01D3669260E33d8b33c93";

async function main() {
  const [deployer] = await hre.ethers.getSigners();
  console.log("Upgrading FreedomRouter...\n");
  console.log("Deployer:", deployer.address);
  console.log("Proxy:", PROXY);

  const balance = await hre.ethers.provider.getBalance(deployer.address);
  console.log("Balance:", hre.ethers.formatEther(balance), "BNB\n");

  const router = await hre.ethers.getContractAt("FreedomRouterImpl", PROXY);
  const owner = await router.owner();
  if (owner.toLowerCase() !== deployer.address.toLowerCase()) {
    console.error("ERROR: deployer is not proxy owner");
    console.error("  Owner:", owner);
    console.error("  Deployer:", deployer.address);
    process.exit(1);
  }

  const oldImpl = "0x" + (await hre.ethers.provider.getStorage(
    PROXY, "0x360894a13ba1a3210667c828492db98dca3e2076cc3735a920a3ca505d382bbc"
  )).slice(26);
  console.log("Old implementation:", oldImpl);

  console.log("\nDeploying new implementation...");
  const Impl = await hre.ethers.getContractFactory("FreedomRouterImpl");
  const impl = await Impl.deploy();
  await impl.waitForDeployment();
  const newImplAddr = await impl.getAddress();
  console.log("New implementation:", newImplAddr);

  console.log("\nUpgrading proxy...");
  const tx = await router.upgradeToAndCall(newImplAddr, "0x", {
    gasPrice: hre.ethers.parseUnits("0.15", "gwei"),
    gasLimit: 200000,
  });
  const receipt = await tx.wait();
  console.log("TX:", receipt.hash);

  const verifyImpl = "0x" + (await hre.ethers.provider.getStorage(
    PROXY, "0x360894a13ba1a3210667c828492db98dca3e2076cc3735a920a3ca505d382bbc"
  )).slice(26);
  console.log("\nVerification:");
  console.log("  Implementation:", verifyImpl);
  console.log("  Owner:", await router.owner());
  console.log("  TM V2:", await router.tokenManagerV2());
  console.log("  Helper3:", await router.tmHelper3());
  console.log("  Flap Portal:", await router.flapPortal());

  console.log("\nDone!");
}

main()
  .then(() => process.exit(0))
  .catch(e => { console.error(e.shortMessage || e.message); process.exit(1); });
