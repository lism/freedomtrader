const { expect } = require("chai");
const { loadFixture } = require("@nomicfoundation/hardhat-network-helpers");
const hre = require("hardhat");

const FORK_ENABLED = Boolean(process.env.BSC_RPC_URL);
const describeFork = FORK_ENABLED ? describe : describe.skip;

const FREEDOM_ROUTER = process.env.ROUTER_ADDRESS || "0x444444444444147c48E01D3669260E33d8b33c93";
const USDT = "0x55d398326f99059fF775485246999027B3197955";

const ERC20_ABI = [
  "function balanceOf(address) view returns (uint256)",
  "function approve(address spender, uint256 amount) returns (bool)",
];

const ROUTER_ABI = [
  "function getTokenInfo(address token, address user) view returns (tuple(string symbol,uint8 decimals,uint256 totalSupply,uint256 userBalance,uint8 routeSource,address approveTarget,uint256 mode,bool isInternal,bool tradingHalt,uint256 tmVersion,address tmAddress,address tmQuote,uint256 tmStatus,uint256 tmFunds,uint256 tmMaxFunds,uint256 tmOffers,uint256 tmMaxOffers,uint256 tmLastPrice,uint256 tmLaunchTime,uint256 tmTradingFeeRate,bool tmLiquidityAdded,uint8 flapStatus,uint256 flapReserve,uint256 flapCirculatingSupply,uint256 flapPrice,uint8 flapTokenVersion,address flapQuoteToken,bool flapNativeSwapEnabled,uint256 flapTaxRate,address flapPool,uint256 flapProgress,address pair,address quoteToken,uint256 pairReserve0,uint256 pairReserve1,bool hasLiquidity,bool isTaxToken,uint256 taxFeeRate))",
];

async function deployForkFixture() {
  const { ethers } = hre;
  const [owner, executor, user] = await ethers.getSigners();

  const BookFactory = await ethers.getContractFactory("LimitOrderBook");
  const book = await BookFactory.deploy(FREEDOM_ROUTER, owner.address, 0);
  await book.waitForDeployment();
  await (await book.setExecutor(executor.address, true)).wait();

  const router = new ethers.Contract(FREEDOM_ROUTER, ROUTER_ABI, owner);
  const usdt = new ethers.Contract(USDT, ERC20_ABI, user);

  return {
    owner,
    executor,
    user,
    book,
    router,
    usdt,
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

describeFork("LimitOrderBook fork integration", function () {
  this.timeout(180000);

  it("predicts the CREATE2 vault address before first escrow and sees a real Pancake route", async function () {
    const { book, router, user, ethers } = await loadFixture(deployForkFixture);

    const predictedVault = await book.predictVault(user.address);
    const [previewVault, deployedBefore] = await book.getUserVault(user.address);
    const routerInfo = await router.getTokenInfo(USDT, user.address);
    const currentPrice = await book.getTokenUsdPrice(USDT);

    expect(previewVault).to.equal(predictedVault);
    expect(deployedBefore).to.equal(false);
    expect(Number(routerInfo.routeSource)).to.equal(7);
    expect(routerInfo.hasLiquidity).to.equal(true);
    expect(currentPrice).to.be.gte(ethers.parseEther("0.9"));
    expect(currentPrice).to.be.lte(ethers.parseEther("1.1"));

    await (await book.connect(user).createBuyOrder(
      USDT,
      (currentPrice * 12n) / 10n,
      3000,
      0,
      await latestExpiry(),
      { value: ethers.parseEther("0.01") }
    )).wait();

    const orderId = await newOrderId(book);
    expect(await book.userVaults(user.address)).to.equal(predictedVault);
    expect(await book.orderVaults(orderId)).to.equal(predictedVault);
    expect(await ethers.provider.getBalance(predictedVault)).to.equal(ethers.parseEther("0.01"));
    expect(await book.reservedNativeByVault(predictedVault)).to.equal(ethers.parseEther("0.01"));
  });

  it("executes a real buy then sell flow through FreedomRouter on the BSC fork", async function () {
    const { book, executor, user, usdt, ethers } = await loadFixture(deployForkFixture);

    const currentPrice = await book.getTokenUsdPrice(USDT);
    const predictedVault = await book.predictVault(user.address);

    const usdtBeforeBuy = await usdt.balanceOf(user.address);
    await (await book.connect(user).createBuyOrder(
      USDT,
      (currentPrice * 12n) / 10n,
      3000,
      0,
      await latestExpiry(),
      { value: ethers.parseEther("0.01") }
    )).wait();

    const buyOrderId = await newOrderId(book);
    await (await book.connect(executor).executeOrder(buyOrderId)).wait();

    const usdtAfterBuy = await usdt.balanceOf(user.address);
    const boughtAmount = usdtAfterBuy - usdtBeforeBuy;
    expect(boughtAmount).to.be.gt(0n);
    expect(await book.userVaults(user.address)).to.equal(predictedVault);
    expect(await usdt.balanceOf(executor.address)).to.equal(0n);
    expect(await book.reservedNativeByVault(predictedVault)).to.equal(0n);

    const sellAmount = boughtAmount / 2n;
    await (await usdt.approve(await book.getAddress(), sellAmount)).wait();
    await (await book.connect(user).createSellOrder(
      USDT,
      sellAmount,
      (currentPrice * 8n) / 10n,
      3000,
      0,
      await latestExpiry()
    )).wait();

    const sellOrderId = await newOrderId(book);
    const userBnbBeforeExecute = await ethers.provider.getBalance(user.address);

    await (await book.connect(executor).executeOrder(sellOrderId)).wait();

    const userBnbAfterExecute = await ethers.provider.getBalance(user.address);
    expect((await book.getOrder(buyOrderId)).status).to.equal(1);
    expect((await book.getOrder(sellOrderId)).status).to.equal(1);
    expect(userBnbAfterExecute).to.be.gt(userBnbBeforeExecute);
    expect(await book.reservedTokenByVault(predictedVault, USDT)).to.equal(0n);
  });
});
