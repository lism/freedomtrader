const hre = require("hardhat");
require("dotenv").config();

/**
 * Step 1: Deploy Factory + Impl on-chain, compute initCodeHash.
 * Output the 3 values needed for offline vanity search.
 */
async function main() {
  const [deployer] = await hre.ethers.getSigners();
  console.log("Deployer:", deployer.address);
  const balance = await hre.ethers.provider.getBalance(deployer.address);
  console.log("Balance:", hre.ethers.formatEther(balance), "BNB\n");

  const config = {
    tokenManagerV2: "0x5c952063c7fc8610FFDB798152D69F0B9550762b",
    helper3: "0xF251F83e40a78868FcfA3FA4599Dad6494E46034",
    flapPortal: "0xe2cE6ab80874Fa9Fa2aAE65D277Dd6B8e65C9De0",
  };

  // 1. Deploy VanityDeployer
  console.log("Deploying VanityDeployer...");
  const Factory = await hre.ethers.getContractFactory("VanityDeployer");
  const factory = await Factory.deploy();
  await factory.waitForDeployment();
  const factoryAddr = await factory.getAddress();
  console.log("  Factory:", factoryAddr);

  // 2. Deploy FreedomRouterImpl
  console.log("Deploying FreedomRouterImpl...");
  const Impl = await hre.ethers.getContractFactory("FreedomRouterImpl");
  const impl = await Impl.deploy();
  await impl.waitForDeployment();
  const implAddr = await impl.getAddress();
  console.log("  Impl:", implAddr);

  // 3. Compute initCodeHash
  const initData = impl.interface.encodeFunctionData("initialize", [
    deployer.address, config.tokenManagerV2, config.helper3, config.flapPortal,
  ]);

  const ProxyFactory = await hre.ethers.getContractFactory("FreedomRouter");
  const deployTx = await ProxyFactory.getDeployTransaction(implAddr, initData);
  const initCode = deployTx.data;
  const initCodeHash = hre.ethers.keccak256(initCode);

  console.log("\n========================================");
  console.log("  服务器离线搜索需要的 3 个值：");
  console.log("========================================");
  console.log(`  Factory:      ${factoryAddr}`);
  console.log(`  initCodeHash: ${initCodeHash}`);
  console.log(`  initCode len: ${initCode.length / 2 - 1} bytes`);
  console.log("========================================\n");

  console.log("搜索公式:");
  console.log("  addr = keccak256(0xff ++ factory ++ salt ++ initCodeHash)[12:]");
  console.log("\n找到好看的 salt 后，回来运行:");
  console.log("  DEPLOY_SALT=<salt> npx hardhat run scripts/deploy-vanity.js --network bsc\n");

  // 矿机命令（与本次 factory/initCodeHash 一致，挖到的 salt 才能用 deploy-vanity 部署出相同地址）
  console.log("========================================");
  console.log("  矿机命令（复制到 GPU 机器）:");
  console.log("========================================");
  console.log(
    `python3 /root/create2_gpu_miner.py --factory ${factoryAddr} --init-code-hash ${initCodeHash} --leading-zeros 15 --global-size 4194304 --batches 50000000`
  );
  console.log("========================================\n");

  // Save for later use（含 initCodeHex 供矿机参数部署用）
  const fs = require("fs");
  fs.writeFileSync("vanity-params.json", JSON.stringify({
    factory: factoryAddr,
    implementation: implAddr,
    initCodeHash,
    initCodeHex: initCode,
    initCodeLength: initCode.length / 2 - 1,
    deployer: deployer.address,
    config,
    timestamp: new Date().toISOString(),
  }, null, 2));
  console.log("Saved to vanity-params.json");
}

main()
  .then(() => process.exit(0))
  .catch(console.error);
