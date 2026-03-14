const hre = require("hardhat");
require("dotenv").config();
const fs = require("fs");

/**
 * Deploy proxy via CREATE2 using a pre-found vanity salt.
 *
 * Usage:
 *   DEPLOY_SALT=0x000000000000000000000000000000000000000000000000000001f939dad4b2 \
 *     npx hardhat run scripts/deploy-vanity.js --network bsc
 */
async function main() {
  const saltHex = process.env.DEPLOY_SALT;
  if (!saltHex) {
    console.error("Error: set DEPLOY_SALT env var");
    process.exit(1);
  }

  // Load previously deployed factory + impl from vanity-params.json
  const params = JSON.parse(fs.readFileSync("vanity-params.json", "utf8"));
  console.log("Loaded vanity-params.json:");
  console.log("  Factory:", params.factory);
  console.log("  Impl:", params.implementation);
  console.log("  initCodeHash:", params.initCodeHash);
  console.log("  Salt:", saltHex);

  const [deployer] = await hre.ethers.getSigners();
  console.log("\nDeployer:", deployer.address);
  const balance = await hre.ethers.provider.getBalance(deployer.address);
  console.log("Balance:", hre.ethers.formatEther(balance), "BNB");

  // Reconstruct initCode (must match what was hashed)
  const impl = await hre.ethers.getContractAt("FreedomRouterImpl", params.implementation);
  const initData = impl.interface.encodeFunctionData("initialize", [
    params.deployer,
    params.config.tokenManagerV2,
    params.config.helper3,
    params.config.flapPortal,
  ]);

  const ProxyFactory = await hre.ethers.getContractFactory("FreedomRouter");
  const deployTx = await ProxyFactory.getDeployTransaction(params.implementation, initData);
  const initCode = deployTx.data;
  const initCodeHash = hre.ethers.keccak256(initCode);

  // Verify hash matches
  if (initCodeHash !== params.initCodeHash) {
    console.error(`\nERROR: initCodeHash mismatch!`);
    console.error(`  Expected: ${params.initCodeHash}`);
    console.error(`  Got:      ${initCodeHash}`);
    process.exit(1);
  }
  console.log("\ninitCodeHash verified ✓");

  // Predict address
  const salt = saltHex.length === 66 ? saltHex : hre.ethers.zeroPadValue(saltHex, 32);
  const predicted = hre.ethers.getCreate2Address(params.factory, salt, initCodeHash);
  console.log("Predicted address:", predicted);

  const expectedAddr = process.env.EXPECTED_ADDRESS;
  if (expectedAddr) {
    const want = (expectedAddr.startsWith("0x") ? expectedAddr : "0x" + expectedAddr).toLowerCase();
    const got = predicted.toLowerCase();
    if (got !== want) {
      console.error("\nERROR: Predicted address does not match EXPECTED_ADDRESS (miner used different factory/initCodeHash).");
      console.error("  Expected (miner):", want);
      console.error("  Predicted (this):", got);
      console.error("\nUse the same factory + initCodeHash as the miner, or re-run miner with current vanity-params.json.");
      process.exit(1);
    }
    console.log("EXPECTED_ADDRESS match ✓");
  }

  // Deploy via factory
  const factory = await hre.ethers.getContractAt("VanityDeployer", params.factory);
  console.log("\nDeploying...");
  const tx = await factory.deploy2(salt, initCode);
  const receipt = await tx.wait();
  console.log("tx:", receipt.hash);

  // Verify
  const proxyAddr = await factory.getDeployed(salt, initCodeHash);
  console.log("\n========================================");
  console.log("  Proxy:", proxyAddr);
  console.log("========================================");

  const router = await hre.ethers.getContractAt("FreedomRouterImpl", proxyAddr);
  console.log("  Owner:", await router.owner());
  console.log("  TM V2:", await router.tokenManagerV2());
  console.log("  Helper3:", await router.tmHelper3());
  console.log("  Flap Portal:", await router.flapPortal());

  fs.writeFileSync("deployment.json", JSON.stringify({
    version: 5,
    proxy: proxyAddr,
    implementation: params.implementation,
    factory: params.factory,
    salt: saltHex,
    deployer: deployer.address,
    timestamp: new Date().toISOString(),
    config: params.config,
  }, null, 2));

  console.log("\nDone!");
}

main()
  .then(() => process.exit(0))
  .catch(console.error);
