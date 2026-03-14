const hre = require("hardhat");

const WBNB = "0xbb4CdB9CBd36B01bD1cBaEBF2De08d9173bc095c";
const USDT = "0x55d398326f99059fF775485246999027B3197955";
const PANCAKE_FACTORY = "0xcA143Ce32Fe78f1f7019d7d551a6402fC5350c73";
const WBNB_USDT_PAIR = "0x16b9a82891338f9bA80E2D6970FddA79D1eb0daE";

function toHex(value) {
  return "0x" + value.toString(16);
}

function assert(condition, message) {
  if (!condition) {
    throw new Error(message);
  }
}

async function expectRevert(label, fn, expectedText) {
  try {
    await fn();
    throw new Error(`${label}: expected revert`);
  } catch (error) {
    const message = error.shortMessage || error.message || String(error);
    if (expectedText && !message.includes(expectedText)) {
      throw new Error(`${label}: unexpected revert -> ${message}`);
    }
    console.log(`PASS ${label}: reverted with "${message}"`);
    return message;
  }
}

async function installRuntimeCode(artifactName, targetAddress) {
  const artifact = await hre.artifacts.readArtifact(artifactName);
  await hre.network.provider.send("hardhat_setCode", [targetAddress, artifact.deployedBytecode]);
  return hre.ethers.getContractAt(artifactName, targetAddress);
}

async function newOrderId(book) {
  const count = await book.getOrderCount();
  return count - 1n;
}

async function main() {
  const { ethers } = hre;
  const [owner, executor, user] = await ethers.getSigners();

  console.log("Local test accounts:");
  console.log(" owner:", owner.address);
  console.log(" exec :", executor.address);
  console.log(" user :", user.address);

  await hre.network.provider.send("hardhat_setBalance", [owner.address, toHex(ethers.parseEther("1000"))]);
  await hre.network.provider.send("hardhat_setBalance", [executor.address, toHex(ethers.parseEther("1000"))]);
  await hre.network.provider.send("hardhat_setBalance", [user.address, toHex(ethers.parseEther("1000"))]);

  const factory = await installRuntimeCode("MockFactory", PANCAKE_FACTORY);
  const pricePair = await installRuntimeCode("MockPair", WBNB_USDT_PAIR);
  await installRuntimeCode("MockDecimals18", WBNB);
  await installRuntimeCode("MockDecimals18", USDT);

  const RouterFactory = await ethers.getContractFactory("MockFreedomRouter");
  const router = await RouterFactory.deploy();
  await router.waitForDeployment();
  await (await router.fund({ value: ethers.parseEther("100") })).wait();

  const TokenFactory = await ethers.getContractFactory("MockERC20");
  const RestrictedFactory = await ethers.getContractFactory("MockRestrictedToken");
  const PairFactory = await ethers.getContractFactory("MockPair");
  const BookFactory = await ethers.getContractFactory("LimitOrderBook");

  const standardToken = await TokenFactory.deploy("Standard Token", "STD", 18);
  await standardToken.waitForDeployment();

  const wbnbQuotedToken = await TokenFactory.deploy("WBNB Token", "WQ", 18);
  await wbnbQuotedToken.waitForDeployment();

  const restrictedToken = await RestrictedFactory.deploy("Restricted Token", "RST", 18);
  await restrictedToken.waitForDeployment();

  const standardPair = await PairFactory.deploy();
  await standardPair.waitForDeployment();
  await (await standardPair.setTokens(await standardToken.getAddress(), USDT)).wait();

  const wbnbPair = await PairFactory.deploy();
  await wbnbPair.waitForDeployment();
  await (await wbnbPair.setTokens(await wbnbQuotedToken.getAddress(), WBNB)).wait();

  const restrictedPair = await PairFactory.deploy();
  await restrictedPair.waitForDeployment();
  await (await restrictedPair.setTokens(await restrictedToken.getAddress(), USDT)).wait();

  await (await factory.setPair(await standardToken.getAddress(), USDT, await standardPair.getAddress())).wait();
  await (await factory.setPair(await wbnbQuotedToken.getAddress(), WBNB, await wbnbPair.getAddress())).wait();
  await (await factory.setPair(await restrictedToken.getAddress(), USDT, await restrictedPair.getAddress())).wait();
  await (await router.setRouteSource(await standardToken.getAddress(), 7)).wait();
  await (await router.setRouteSource(await wbnbQuotedToken.getAddress(), 7)).wait();

  const book = await BookFactory.deploy(await router.getAddress(), owner.address, 0);
  await book.waitForDeployment();
  await (await book.setExecutor(executor.address, true)).wait();

  console.log("\nDeployed:");
  console.log(" router:", await router.getAddress());
  console.log(" book  :", await book.getAddress());
  console.log(" std   :", await standardToken.getAddress());
  console.log(" wq    :", await wbnbQuotedToken.getAddress());
  console.log(" rst   :", await restrictedToken.getAddress());

  console.log("\n[1] Escrow is isolated in a per-user vault");
  const predictedVault = await book.predictVault(user.address);
  const userVaultPreview = await book.getUserVault(user.address);
  assert(userVaultPreview[0] === predictedVault, "predicted vault preview mismatch");
  assert(userVaultPreview[1] === false, "vault should not be deployed before first order");
  await (await book.connect(user).createBuyOrder(
    await standardToken.getAddress(),
    ethers.parseEther("100"),
    0,
    0,
    (await ethers.provider.getBlock("latest")).timestamp + 3600,
    { value: ethers.parseEther("0.5") }
  )).wait();
  const vault = await book.userVaults(user.address);
  const buyVaultOrderId = await newOrderId(book);
  assert(vault === predictedVault, "deployed vault should match CREATE2 prediction");
  assert(vault !== ethers.ZeroAddress, "vault should be created");
  assert(await book.orderVaults(buyVaultOrderId) === vault, "buy order vault mismatch");
  assert(await book.reservedNativeByVault(vault) === ethers.parseEther("0.5"), "buy reservation mismatch");
  assert(await book.availableNativeByVault(vault) === 0n, "buy vault should have no idle BNB");
  assert(await ethers.provider.getBalance(await book.getAddress()) === 0n, "book should not hold buy escrow");
  assert(await ethers.provider.getBalance(vault) === ethers.parseEther("0.5"), "vault should hold buy escrow");

  await (await standardToken.mint(user.address, ethers.parseEther("2"))).wait();
  await (await standardToken.connect(user).approve(await book.getAddress(), ethers.parseEther("2"))).wait();
  await (await book.connect(user).createSellOrder(
    await standardToken.getAddress(),
    ethers.parseEther("2"),
    ethers.parseEther("100"),
    0,
    0,
    (await ethers.provider.getBlock("latest")).timestamp + 3600
  )).wait();
  const sellVaultOrderId = await newOrderId(book);
  assert(await book.orderVaults(sellVaultOrderId) === vault, "sell order should reuse the same vault");
  assert(
    await book.reservedTokenByVault(vault, await standardToken.getAddress()) === ethers.parseEther("2"),
    "sell reservation mismatch"
  );
  assert(
    await book.availableTokenByVault(vault, await standardToken.getAddress()) === 0n,
    "sell vault should have no idle token balance"
  );
  assert(await standardToken.balanceOf(await book.getAddress()) === 0n, "book should not hold sell escrow");
  assert(await standardToken.balanceOf(vault) === ethers.parseEther("2"), "vault should hold sell escrow");
  await (await book.connect(user).cancelOrder(buyVaultOrderId)).wait();
  assert(await book.reservedNativeByVault(vault) === 0n, "buy reservation should clear after cancel");
  await (await book.connect(user).cancelOrder(sellVaultOrderId)).wait();
  assert(
    await book.reservedTokenByVault(vault, await standardToken.getAddress()) === 0n,
    "sell reservation should clear after cancel"
  );
  console.log(`PASS vault isolation: user escrow lives in ${vault}`);

  console.log("\n[2] Happy path buy order");
  await (await pricePair.setTokens(WBNB, USDT)).wait();
  await (await pricePair.setReserves(
    ethers.parseUnits("100", 18),
    ethers.parseUnits("40000", 18)
  )).wait();
  await (await standardPair.setReserves(
    ethers.parseUnits("10", 18),
    ethers.parseUnits("1000", 18)
  )).wait();
  await (await router.setBuyRate(await standardToken.getAddress(), ethers.parseUnits("4", 18))).wait();

  await (await book.connect(user).createBuyOrder(
    await standardToken.getAddress(),
    ethers.parseEther("100"),
    0,
    0,
    (await ethers.provider.getBlock("latest")).timestamp + 3600,
    { value: ethers.parseEther("1") }
  )).wait();
  const happyOrderId = await newOrderId(book);
  const happyBalanceBefore = await standardToken.balanceOf(user.address);
  await (await book.connect(executor).executeOrder(happyOrderId)).wait();
  const happyBalance = await standardToken.balanceOf(user.address);
  assert(happyBalance - happyBalanceBefore === ethers.parseEther("4"), "happy path token amount mismatch");
  assert(await standardToken.balanceOf(executor.address) === 0n, "executor should not receive buy output");
  console.log(`PASS happy path: user received ${ethers.formatEther(happyBalance - happyBalanceBefore)} STD`);

  console.log("\n[3] WBNB/USD reserve math is correct");
  await (await wbnbPair.setReserves(
    ethers.parseUnits("10", 18),
    ethers.parseUnits("10", 18)
  )).wait();
  await (await pricePair.setTokens(USDT, WBNB)).wait();
  await (await pricePair.setReserves(
    ethers.parseUnits("40000", 18),
    ethers.parseUnits("100", 18)
  )).wait();

  const fixedUsdPrice = await book.getTokenUsdPrice(await wbnbQuotedToken.getAddress());
  console.log(`Observed WBNB-quoted price: $${ethers.formatEther(fixedUsdPrice)}`);
  assert(fixedUsdPrice >= ethers.parseEther("399"), "price too low after reserve fix");
  assert(fixedUsdPrice <= ethers.parseEther("401"), "price too high after reserve fix");
  console.log("PASS WBNB/USD price fix: quoted price stayed near $400");

  console.log("\n[4] Sell order rejects terrible execution price");
  await (await standardToken.mint(user.address, ethers.parseEther("10"))).wait();
  await (await standardPair.setReserves(
    ethers.parseUnits("10", 18),
    ethers.parseUnits("1200", 18)
  )).wait();
  await (await router.setFixedSellOut(await standardToken.getAddress(), ethers.parseEther("0.01"))).wait();
  await (await standardToken.connect(user).approve(await book.getAddress(), ethers.parseEther("10"))).wait();

  const userBnbBefore = await ethers.provider.getBalance(user.address);
  await (await book.connect(user).createSellOrder(
    await standardToken.getAddress(),
    ethers.parseEther("10"),
    ethers.parseEther("100"),
    100,
    0,
    (await ethers.provider.getBlock("latest")).timestamp + 3600
  )).wait();
  const sellOrderId = await newOrderId(book);
  await expectRevert(
    "reject terrible sell execution",
    async () => {
      await book.connect(executor).executeOrder(sellOrderId);
    },
    "Slippage"
  );
  const sellOrder = await book.getOrder(sellOrderId);
  assert(Number(sellOrder.status) === 0, "sell order should stay pending after failed execution");
  await (await book.connect(user).cancelOrder(sellOrderId)).wait();
  const userBnbAfter = await ethers.provider.getBalance(user.address);
  assert(userBnbAfter < userBnbBefore, "gas spend should leave user balance slightly lower");
  console.log("PASS sell slippage fix: terrible execution reverted and order stayed cancellable");

  console.log("\n[5] Pending escrow is outside rescue scope");
  await (await book.connect(user).createBuyOrder(
    await standardToken.getAddress(),
    ethers.parseEther("100"),
    0,
    0,
    (await ethers.provider.getBlock("latest")).timestamp + 3600,
    { value: ethers.parseEther("0.5") }
  )).wait();
  const escrowOrderId = await newOrderId(book);
  assert(await ethers.provider.getBalance(vault) === ethers.parseEther("0.5"), "vault should keep pending buy escrow");
  assert(await ethers.provider.getBalance(await book.getAddress()) === 0n, "book should still have no escrow balance");
  await expectRevert(
    "owner rescue blocked",
    async () => {
      await book.rescueTokens(ethers.ZeroAddress, ethers.parseEther("0.5"));
    },
    "Insufficient balance"
  );
  await (await book.connect(user).cancelOrder(escrowOrderId)).wait();
  const cancelledEscrowOrder = await book.getOrder(escrowOrderId);
  assert(Number(cancelledEscrowOrder.status) === 2, "escrow order should stay cancellable");
  console.log("PASS rescue scope fix: entry contract cannot touch vault escrow");

  console.log("\n[6] Unsupported custody routes are rejected up front");
  await (await router.setRouteSource(await restrictedToken.getAddress(), 1)).wait();
  await expectRevert(
    "reject internal custody route",
    async () => {
      await book.connect(user).createBuyOrder(
        await restrictedToken.getAddress(),
        ethers.parseEther("100"),
        0,
        0,
        (await ethers.provider.getBlock("latest")).timestamp + 3600,
        { value: ethers.parseEther("1") }
      );
    },
    "Unsupported custody route"
  );
  console.log("PASS custody check: internal/non-custodial route blocked before escrow");

  console.log("\n[7] Buy order still executes with non-zero tip");
  await (await standardPair.setReserves(
    ethers.parseUnits("10", 18),
    ethers.parseUnits("1000", 18)
  )).wait();
  const tipBuyBalanceBefore = await standardToken.balanceOf(user.address);
  await (await book.connect(user).createBuyOrder(
    await standardToken.getAddress(),
    ethers.parseEther("100"),
    0,
    500,
    (await ethers.provider.getBlock("latest")).timestamp + 3600,
    { value: ethers.parseEther("1") }
  )).wait();
  const tipOrderId = await newOrderId(book);
  await (await book.connect(executor).executeOrder(tipOrderId)).wait();
  const tipBuyBalanceAfter = await standardToken.balanceOf(user.address);
  assert(tipBuyBalanceAfter - tipBuyBalanceBefore === ethers.parseEther("3.8"), "tip-adjusted buy output mismatch");
  assert(await standardToken.balanceOf(executor.address) === 0n, "executor should not receive tip buy output");
  console.log("PASS buy tip fix: minOut matched post-tip swap amount");

  console.log("\n[8] batchExecute respects target price");
  await (await standardPair.setReserves(
    ethers.parseUnits("10", 18),
    ethers.parseUnits("1000", 18)
  )).wait();
  await (await pricePair.setTokens(WBNB, USDT)).wait();
  await (await pricePair.setReserves(
    ethers.parseUnits("100", 18),
    ethers.parseUnits("40000", 18)
  )).wait();
  await (await standardToken.mint(user.address, ethers.parseEther("5"))).wait();
  await (await standardToken.connect(user).approve(await book.getAddress(), ethers.parseEther("5"))).wait();
  await (await router.setFixedSellOut(await standardToken.getAddress(), ethers.parseEther("0.02"))).wait();
  await (await book.connect(user).createSellOrder(
    await standardToken.getAddress(),
    ethers.parseEther("5"),
    ethers.parseEther("1000"),
    0,
    0,
    (await ethers.provider.getBlock("latest")).timestamp + 3600
  )).wait();
  const unsafeBatchOrderId = await newOrderId(book);
  const [executableBefore] = await book.checkExecutable(unsafeBatchOrderId);
  assert(executableBefore === false, "order should not be executable before unsafe batch");
  await (await book.connect(executor).batchExecute([unsafeBatchOrderId])).wait();
  const unsafeBatchOrder = await book.getOrder(unsafeBatchOrderId);
  assert(Number(unsafeBatchOrder.status) === 0, "batch execution should leave non-executable order pending");
  await (await book.connect(user).cancelOrder(unsafeBatchOrderId)).wait();
  console.log("PASS batch execution fix: non-executable order was skipped");

  console.log("\nAll local scenarios completed.");
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
