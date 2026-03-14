const { expect } = require("chai");
const hre = require("hardhat");

const WBNB = "0xbb4CdB9CBd36B01bD1cBaEBF2De08d9173bc095c";
const USDT = "0x55d398326f99059fF775485246999027B3197955";
const PANCAKE_FACTORY = "0xcA143Ce32Fe78f1f7019d7d551a6402fC5350c73";
const WBNB_USDT_PAIR = "0x16b9a82891338f9bA80E2D6970FddA79D1eb0daE";

async function installRuntimeCode(artifactName, targetAddress) {
  const artifact = await hre.artifacts.readArtifact(artifactName);
  await hre.network.provider.send("hardhat_setCode", [targetAddress, artifact.deployedBytecode]);
  return hre.ethers.getContractAt(artifactName, targetAddress);
}

async function deployFixture() {
  const { ethers } = hre;
  const [owner, executor, user] = await ethers.getSigners();

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

  return {
    owner,
    executor,
    user,
    router,
    book,
    pricePair,
    standardPair,
    wbnbPair,
    restrictedPair,
    standardToken,
    wbnbQuotedToken,
    restrictedToken,
    ethers,
  };
}

async function latestExpiry() {
  const block = await hre.ethers.provider.getBlock("latest");
  return block.timestamp + 3600;
}

async function newOrderId(book) {
  const count = await book.getOrderCount();
  return count - 1n;
}

describe("LimitOrderBook", function () {
  it("keeps escrow in a reused per-user vault", async function () {
    const { book, standardToken, user, ethers } = await deployFixture();
    const predictedVault = await book.predictVault(user.address);
    const [, deployedBefore] = await book.getUserVault(user.address);

    expect(deployedBefore).to.equal(false);
    expect(await book.userVaults(user.address)).to.equal(ethers.ZeroAddress);

    await (await book.connect(user).createBuyOrder(
      await standardToken.getAddress(),
      ethers.parseEther("100"),
      0,
      0,
      await latestExpiry(),
      { value: ethers.parseEther("0.5") }
    )).wait();

    const buyOrderId = await newOrderId(book);
    const vault = await book.userVaults(user.address);

    expect(vault).to.equal(predictedVault);
    expect(vault).to.not.equal(ethers.ZeroAddress);
    expect(await book.orderVaults(buyOrderId)).to.equal(vault);
    expect(await book.reservedNativeByVault(vault)).to.equal(ethers.parseEther("0.5"));
    expect(await book.availableNativeByVault(vault)).to.equal(0n);
    expect(await hre.ethers.provider.getBalance(await book.getAddress())).to.equal(0n);
    expect(await hre.ethers.provider.getBalance(vault)).to.equal(ethers.parseEther("0.5"));

    const buyEscrow = await book.getOrderEscrow(buyOrderId);
    expect(buyEscrow.vault).to.equal(vault);
    expect(buyEscrow.asset).to.equal(ethers.ZeroAddress);
    expect(buyEscrow.amount).to.equal(ethers.parseEther("0.5"));
    expect(buyEscrow.beneficiary).to.equal(user.address);
    expect(buyEscrow.pending).to.equal(true);

    await (await standardToken.mint(user.address, ethers.parseEther("2"))).wait();
    await (await standardToken.connect(user).approve(await book.getAddress(), ethers.parseEther("2"))).wait();

    await (await book.connect(user).createSellOrder(
      await standardToken.getAddress(),
      ethers.parseEther("2"),
      ethers.parseEther("100"),
      0,
      0,
      await latestExpiry()
    )).wait();

    const sellOrderId = await newOrderId(book);
    expect(await book.orderVaults(sellOrderId)).to.equal(vault);
    expect(await book.reservedTokenByVault(vault, await standardToken.getAddress())).to.equal(ethers.parseEther("2"));
    expect(await book.availableTokenByVault(vault, await standardToken.getAddress())).to.equal(0n);
    expect(await standardToken.balanceOf(await book.getAddress())).to.equal(0n);
    expect(await standardToken.balanceOf(vault)).to.equal(ethers.parseEther("2"));

    const sellEscrow = await book.getOrderEscrow(sellOrderId);
    expect(sellEscrow.asset).to.equal(await standardToken.getAddress());
    expect(sellEscrow.beneficiary).to.equal(user.address);

    await (await book.connect(user).cancelOrder(buyOrderId)).wait();
    expect(await book.reservedNativeByVault(vault)).to.equal(0n);
    await (await book.connect(user).cancelOrder(sellOrderId)).wait();
    expect(await book.reservedTokenByVault(vault, await standardToken.getAddress())).to.equal(0n);
  });

  it("executes a normal buy order", async function () {
    const { book, router, pricePair, standardPair, standardToken, executor, user, ethers } = await deployFixture();

    await (await pricePair.setTokens(WBNB, USDT)).wait();
    await (await pricePair.setReserves(ethers.parseUnits("100", 18), ethers.parseUnits("40000", 18))).wait();
    await (await standardPair.setReserves(ethers.parseUnits("10", 18), ethers.parseUnits("1000", 18))).wait();
    await (await router.setBuyRate(await standardToken.getAddress(), ethers.parseUnits("4", 18))).wait();

    await (await book.connect(user).createBuyOrder(
      await standardToken.getAddress(),
      ethers.parseEther("100"),
      0,
      0,
      await latestExpiry(),
      { value: ethers.parseEther("1") }
    )).wait();

    const orderId = await newOrderId(book);
    const vault = await book.userVaults(user.address);
    await (await book.connect(executor).executeOrder(orderId)).wait();

    expect(await standardToken.balanceOf(user.address)).to.equal(ethers.parseEther("4"));
    expect(await standardToken.balanceOf(executor.address)).to.equal(0n);
    expect(await book.reservedNativeByVault(vault)).to.equal(0n);
  });

  it("prices WBNB-quoted tokens correctly", async function () {
    const { book, pricePair, wbnbPair, wbnbQuotedToken, ethers } = await deployFixture();

    await (await wbnbPair.setReserves(ethers.parseUnits("10", 18), ethers.parseUnits("10", 18))).wait();
    await (await pricePair.setTokens(USDT, WBNB)).wait();
    await (await pricePair.setReserves(ethers.parseUnits("40000", 18), ethers.parseUnits("100", 18))).wait();

    const price = await book.getTokenUsdPrice(await wbnbQuotedToken.getAddress());
    expect(price).to.be.gte(ethers.parseEther("399"));
    expect(price).to.be.lte(ethers.parseEther("401"));
  });

  it("rejects terrible sell execution prices", async function () {
    const { book, router, pricePair, standardPair, standardToken, executor, user, ethers } = await deployFixture();

    await (await pricePair.setTokens(WBNB, USDT)).wait();
    await (await pricePair.setReserves(ethers.parseUnits("100", 18), ethers.parseUnits("40000", 18))).wait();
    await (await standardPair.setReserves(ethers.parseUnits("10", 18), ethers.parseUnits("1200", 18))).wait();
    await (await router.setFixedSellOut(await standardToken.getAddress(), ethers.parseEther("0.01"))).wait();
    await (await standardToken.mint(user.address, ethers.parseEther("10"))).wait();
    await (await standardToken.connect(user).approve(await book.getAddress(), ethers.parseEther("10"))).wait();

    await (await book.connect(user).createSellOrder(
      await standardToken.getAddress(),
      ethers.parseEther("10"),
      ethers.parseEther("100"),
      100,
      0,
      await latestExpiry()
    )).wait();

    const orderId = await newOrderId(book);
    const vault = await book.userVaults(user.address);
    await expect(book.connect(executor).executeOrder(orderId)).to.be.revertedWith("Slippage");
    expect((await book.getOrder(orderId)).status).to.equal(0);
    expect(await book.reservedTokenByVault(vault, await standardToken.getAddress())).to.equal(ethers.parseEther("10"));
  });

  it("keeps pending escrow outside order-book rescue scope", async function () {
    const { book, standardToken, user, ethers } = await deployFixture();

    await (await book.connect(user).createBuyOrder(
      await standardToken.getAddress(),
      ethers.parseEther("100"),
      0,
      0,
      await latestExpiry(),
      { value: ethers.parseEther("0.5") }
    )).wait();

    const orderId = await newOrderId(book);
    const vault = await book.userVaults(user.address);

    expect(await hre.ethers.provider.getBalance(vault)).to.equal(ethers.parseEther("0.5"));
    expect(await hre.ethers.provider.getBalance(await book.getAddress())).to.equal(0n);

    await expect(
      book.rescueTokens(ethers.ZeroAddress, ethers.parseEther("0.5"))
    ).to.be.revertedWith("Insufficient balance");

    await (await book.connect(user).cancelOrder(orderId)).wait();
    expect((await book.getOrder(orderId)).status).to.equal(2);
  });

  it("rejects unsupported custody routes before escrow", async function () {
    const { book, router, restrictedToken, user, ethers } = await deployFixture();

    await (await router.setRouteSource(await restrictedToken.getAddress(), 1)).wait();

    await expect(
      book.connect(user).createBuyOrder(
        await restrictedToken.getAddress(),
        ethers.parseEther("100"),
        0,
        0,
        await latestExpiry(),
        { value: ethers.parseEther("1") }
      )
    ).to.be.revertedWith("Unsupported custody route");
  });

  it("aligns buy minOut with post-tip swap value", async function () {
    const { book, router, pricePair, standardPair, standardToken, executor, user, ethers } = await deployFixture();

    await (await pricePair.setTokens(WBNB, USDT)).wait();
    await (await pricePair.setReserves(ethers.parseUnits("100", 18), ethers.parseUnits("40000", 18))).wait();
    await (await standardPair.setReserves(ethers.parseUnits("10", 18), ethers.parseUnits("1000", 18))).wait();
    await (await router.setBuyRate(await standardToken.getAddress(), ethers.parseUnits("4", 18))).wait();

    await (await book.connect(user).createBuyOrder(
      await standardToken.getAddress(),
      ethers.parseEther("100"),
      0,
      500,
      await latestExpiry(),
      { value: ethers.parseEther("1") }
    )).wait();

    const orderId = await newOrderId(book);
    const vault = await book.userVaults(user.address);
    await (await book.connect(executor).executeOrder(orderId)).wait();
    expect(await standardToken.balanceOf(user.address)).to.equal(ethers.parseEther("3.8"));
    expect(await standardToken.balanceOf(executor.address)).to.equal(0n);
    expect(await book.reservedNativeByVault(vault)).to.equal(0n);
  });

  it("skips non-executable orders in batch execution", async function () {
    const { book, router, pricePair, standardPair, standardToken, executor, user, ethers } = await deployFixture();

    await (await pricePair.setTokens(WBNB, USDT)).wait();
    await (await pricePair.setReserves(ethers.parseUnits("100", 18), ethers.parseUnits("40000", 18))).wait();
    await (await standardPair.setReserves(ethers.parseUnits("10", 18), ethers.parseUnits("1000", 18))).wait();
    await (await router.setFixedSellOut(await standardToken.getAddress(), ethers.parseEther("0.02"))).wait();
    await (await standardToken.mint(user.address, ethers.parseEther("5"))).wait();
    await (await standardToken.connect(user).approve(await book.getAddress(), ethers.parseEther("5"))).wait();

    await (await book.connect(user).createSellOrder(
      await standardToken.getAddress(),
      ethers.parseEther("5"),
      ethers.parseEther("1000"),
      0,
      0,
      await latestExpiry()
    )).wait();

    const orderId = await newOrderId(book);
    const [executableBefore] = await book.checkExecutable(orderId);
    expect(executableBefore).to.equal(false);

    await (await book.connect(executor).batchExecute([orderId])).wait();
    expect((await book.getOrder(orderId)).status).to.equal(0);
  });
});
