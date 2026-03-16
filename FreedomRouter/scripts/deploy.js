const hre = require("hardhat");
require("dotenv").config();

async function main() {
  const [deployer] = await hre.ethers.getSigners();
  console.log("Deploying FreedomRouter v6.1 (UUPS Proxy)...\n");
  console.log("Deployer:", deployer.address);

  const balance = await hre.ethers.provider.getBalance(deployer.address);
  console.log("Balance:", hre.ethers.formatEther(balance), "BNB\n");

  const config = {
    tokenManagerV2: "0x5c952063c7fc8610FFDB798152D69F0B9550762b",
    helper3: "0xF251F83e40a78868FcfA3FA4599Dad6494E46034",
    flapPortal: "0xe2cE6ab80874Fa9Fa2aAE65D277Dd6B8e65C9De0",
  };

  // 1. 部署 Implementation
  const Impl = await hre.ethers.getContractFactory("FreedomRouterImpl");
  const impl = await Impl.deploy();
  await impl.waitForDeployment();
  const implAddr = await impl.getAddress();
  console.log("Implementation:", implAddr);

  // 2. 编码 initialize calldata (v6.1: tmV2, helper3, flapPortal)
  const initData = impl.interface.encodeFunctionData("initialize", [
    deployer.address,
    config.tokenManagerV2,
    config.helper3,
    config.flapPortal,
  ]);

  // 3. 部署 Proxy
  const Proxy = await hre.ethers.getContractFactory("FreedomRouter");
  const proxy = await Proxy.deploy(implAddr, initData);
  await proxy.waitForDeployment();
  const proxyAddr = await proxy.getAddress();
  console.log("Proxy:", proxyAddr);

  // 验证
  const router = await hre.ethers.getContractAt("FreedomRouterImpl", proxyAddr);
  const tmV2 = await router.tokenManagerV2();
  const h3 = await router.tmHelper3();
  const fp = await router.flapPortal();
  const owner = await router.owner();

  console.log("\n配置:");
  console.log("  TokenManager V2:", tmV2);
  console.log("  Helper3:", h3);
  console.log("  Flap Portal:", fp);
  console.log("  Owner:", owner);

  const fs = require("fs");
  fs.writeFileSync("deployment.json", JSON.stringify({
    version: "6.1",
    proxy: proxyAddr,
    implementation: implAddr,
    deployer: deployer.address,
    timestamp: new Date().toISOString(),
    config
  }, null, 2));

  console.log("\nDone");
}

main()
  .then(() => process.exit(0))
  .catch(console.error);
