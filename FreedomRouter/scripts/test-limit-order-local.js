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
  const [owner, user] = await ethers.getSigners();

  console.log("Local test accounts:");
  console.log(" owner:", owner.address);
  console.log(" user :", user.address);

  await hre.network.provider.send("hardhat_setBalance", [owner.address, toHex(ethers.parseEther("1000"))]);
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

  const book = await BookFactory.deploy(await router.getAddress(), owner.address, 0);
  await book.waitForDeployment();
  await (await book.setExecutor(owner.address, true)).wait();

  console.log("\nDeployed:");
  console.log(" router:", await router.getAddress());
  console.log(" book  :", await book.getAddress());
  console.log(" std   :", await standardToken.getAddress());
  console.log(" wq    :", await wbnbQuotedToken.getAddress());
  console.log(" rst   :", await restrictedToken.getAddress());

  // Scenario 1: basic happy path buy order.
  console.log("\n[1] Happy path buy order");
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
  await (await book.executeOrder(happyOrderId)).wait();
  const happyOrder = await book.getOrder(happyOrderId);
  const happyBalance = await standardToken.balanceOf(user.address);
  assert(Number(happyOrder.status) === 1, "happy path order not executed");
  assert(happyBalance === ethers.parseEther("4"), "happy path token amount mismatch");
  console.log(`PASS happy path: user received ${ethers.formatEther(happyBalance)} STD`);

  // Scenario 2: WBNB/USD price inversion bug.
  console.log("\n[2] WBNB/USD reserve inversion");
  await (await wbnbPair.setReserves(
    ethers.parseUnits("10", 18),
    ethers.parseUnits("10", 18)
  )).wait();
  // Standard V2 ordering here is effectively USDT reserve first, WBNB reserve second.
  await (await pricePair.setTokens(USDT, WBNB)).wait();
  await (await pricePair.setReserves(
    ethers.parseUnits("40000", 18),
    ethers.parseUnits("100", 18)
  )).wait();

  const brokenUsdPrice = await book.getTokenUsdPrice(await wbnbQuotedToken.getAddress());
  console.log(`Observed WBNB-quoted price: $${ethers.formatEther(brokenUsdPrice)}`);
  assert(brokenUsdPrice < ethers.parseEther("1"), "expected inverted price to collapse below $1");
  console.log("PASS inversion reproduced: expected ~$400, got near zero due to flipped reserve math");

  // Scenario 3: sell slippage is ignored because amountOutMin is forced to 0.
  console.log("\n[3] Sell order can execute at a terrible price");
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
  await (await book.executeOrder(sellOrderId)).wait();
  const sellOrder = await book.getOrder(sellOrderId);
  const userBnbAfter = await ethers.provider.getBalance(user.address);
  const deltaBnb = userBnbAfter - userBnbBefore;
  console.log(`Observed sell payout delta: ${ethers.formatEther(deltaBnb)} BNB`);
  assert(Number(sellOrder.status) === 1, "sell order did not execute");
  assert(deltaBnb < ethers.parseEther("0.02"), "sell order should have settled for a tiny amount");
  console.log("PASS slippage bug reproduced: target met, but execution still settled near zero");

  // Scenario 4: owner can drain user escrow.
  console.log("\n[4] Owner can rescue pending escrow");
  await (await book.connect(user).createBuyOrder(
    await standardToken.getAddress(),
    ethers.parseEther("100"),
    0,
    0,
    (await ethers.provider.getBlock("latest")).timestamp + 3600,
    { value: ethers.parseEther("0.5") }
  )).wait();
  const escrowOrderId = await newOrderId(book);
  await (await book.rescueTokens(ethers.ZeroAddress, ethers.parseEther("0.5"))).wait();
  await expectRevert(
    "cancel after owner rescue",
    async () => {
      await book.connect(user).cancelOrder(escrowOrderId);
    },
    "reverted"
  );

  // Scenario 5: non-transferable token breaks custody model.
  console.log("\n[5] Non-transferable token cannot be delivered to the buyer");
  await (await restrictedPair.setReserves(
    ethers.parseUnits("10", 18),
    ethers.parseUnits("1000", 18)
  )).wait();
  await (await pricePair.setTokens(WBNB, USDT)).wait();
  await (await pricePair.setReserves(
    ethers.parseUnits("100", 18),
    ethers.parseUnits("40000", 18)
  )).wait();
  await (await router.setBuyRate(await restrictedToken.getAddress(), ethers.parseUnits("4", 18))).wait();

  await (await book.connect(user).createBuyOrder(
    await restrictedToken.getAddress(),
    ethers.parseEther("100"),
    0,
    0,
    (await ethers.provider.getBlock("latest")).timestamp + 3600,
    { value: ethers.parseEther("1") }
  )).wait();
  const restrictedOrderId = await newOrderId(book);
  await expectRevert(
    "execute restricted token order",
    async () => {
      await book.executeOrder(restrictedOrderId);
    },
    "Transfers disabled"
  );
  const restrictedOrder = await book.getOrder(restrictedOrderId);
  assert(Number(restrictedOrder.status) === 0, "restricted token order should stay pending after revert");

  // Scenario 6: buy minOut ignores router tip.
  console.log("\n[6] Buy order fails when tip is non-zero");
  await (await standardPair.setReserves(
    ethers.parseUnits("10", 18),
    ethers.parseUnits("1000", 18)
  )).wait();
  await (await book.connect(user).createBuyOrder(
    await standardToken.getAddress(),
    ethers.parseEther("100"),
    0,
    500,
    (await ethers.provider.getBlock("latest")).timestamp + 3600,
    { value: ethers.parseEther("1") }
  )).wait();
  const tipOrderId = await newOrderId(book);
  await expectRevert(
    "execute buy order with tip",
    async () => {
      await book.executeOrder(tipOrderId);
    },
    "Slippage"
  );
  const tipOrder = await book.getOrder(tipOrderId);
  assert(Number(tipOrder.status) === 0, "tip order should stay pending after revert");

  console.log("\nAll local scenarios completed.");
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
