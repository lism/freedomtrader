const hre = require("hardhat");
require("dotenv").config();

const LIMIT_ORDER = process.env.LIMIT_ORDER_ADDRESS || "";
const ROUTER      = process.env.ROUTER_ADDRESS || "0x444444444444147c48E01D3669260E33d8b33c93";
const TOKEN       = process.env.TOKEN_ADDRESS || "0x17e915ec75ba049ee32b9aa87d1d119346a24444";
const GAS         = { gasPrice: hre.ethers.parseUnits("0.15", "gwei"), gasLimit: 1200000 };

const ERC20 = [
  "function balanceOf(address) view returns (uint256)",
  "function approve(address,uint256) returns (bool)",
  "function allowance(address,address) view returns (uint256)",
  "function symbol() view returns (string)",
  "function decimals() view returns (uint8)",
];

async function main() {
  const cmd = process.env.CMD || "info";
  const [signer] = await hre.ethers.getSigners();

  if (!LIMIT_ORDER) {
    console.error("Set LIMIT_ORDER_ADDRESS env var");
    process.exit(1);
  }

  const book   = await hre.ethers.getContractAt("LimitOrderBook", LIMIT_ORDER);
  const token  = new hre.ethers.Contract(TOKEN, ERC20, signer);
  const symbol = await token.symbol();
  const decimals = await token.decimals();
  const fmt  = (v) => hre.ethers.formatUnits(v, decimals);
  const fmtE = (v) => hre.ethers.formatEther(v);

  console.log(`LimitOrderBook: ${LIMIT_ORDER}`);
  console.log(`Router: ${await book.router()}`);
  console.log(`Token: ${symbol} (${TOKEN})`);
  console.log(`Account: ${signer.address}`);
  console.log();

  if (cmd === "info") {
    const orderCount = await book.getOrderCount();
    const bnb = await hre.ethers.provider.getBalance(signer.address);
    const bnbUsd = await book._getBnbUsdPrice !== undefined
      ? "N/A"
      : "N/A";

    console.log(`BNB: ${fmtE(bnb)}  ${symbol}: ${fmt(await token.balanceOf(signer.address))}`);
    console.log(`Total orders: ${orderCount}`);

    // Token USD price
    try {
      const price = await book.getTokenUsdPrice(TOKEN);
      console.log(`Token USD price: $${hre.ethers.formatEther(price)}`);
    } catch (e) {
      console.log(`Token USD price: error (${e.shortMessage || e.message.slice(0, 100)})`);
    }

    // User orders
    const userOrderIds = await book.getUserOrders(signer.address);
    console.log(`\nUser orders (${userOrderIds.length}):`);
    for (const id of userOrderIds) {
      const o = await book.getOrder(id);
      const status = ["Pending", "Executed", "Cancelled", "Expired"][Number(o.status)];
      const side = o.isBuy ? "BUY" : "SELL";
      const amt = o.isBuy ? fmtE(o.amount) + " BNB" : fmt(o.amount) + " " + symbol;
      const target = hre.ethers.formatEther(o.targetPrice);
      const expiry = new Date(Number(o.expiry) * 1000).toISOString();
      console.log(`  #${id}: ${side} ${amt} @ $${target} | ${status} | expires ${expiry}`);
    }

    // Config
    console.log(`\nConfig:`);
    console.log(`  feeBps: ${await book.feeBps()}`);
    console.log(`  feeRecipient: ${await book.feeRecipient()}`);
    console.log(`  executor[${signer.address}]: ${await book.executors(signer.address)}`);
  }

  else if (cmd === "price") {
    const price = await book.getTokenUsdPrice(TOKEN);
    console.log(`Token USD price: $${hre.ethers.formatEther(price)}`);
  }

  else if (cmd === "create-buy") {
    const amount = process.env.AMOUNT || "0.0001";
    const targetPrice = process.env.TARGET_PRICE; // USD per token, e.g. "0.000001"
    const slippage = parseInt(process.env.SLIPPAGE || "500"); // 5% default
    const tipRate = parseInt(process.env.TIP || "0");
    const hours = parseInt(process.env.HOURS || "24");
    const expiry = Math.floor(Date.now() / 1000) + hours * 3600;

    if (!targetPrice) {
      console.error("Set TARGET_PRICE env var (USD per token, e.g. 0.000001)");
      process.exit(1);
    }

    console.log(`创建买单: ${amount} BNB → ${symbol}`);
    console.log(`目标价: $${targetPrice}  滑点: ${slippage/100}%  有效期: ${hours}h`);

    const tx = await book.createBuyOrder(
      TOKEN,
      hre.ethers.parseEther(targetPrice),
      slippage,
      tipRate,
      expiry,
      { value: hre.ethers.parseEther(amount), ...GAS }
    );
    console.log("TX:", tx.hash);
    const r = await tx.wait();
    for (const log of r.logs) {
      try {
        const p = book.interface.parseLog(log);
        if (p?.name === "OrderCreated") {
          console.log(`订单创建成功: #${p.args.orderId}`);
        }
      } catch {}
    }
  }

  else if (cmd === "create-sell") {
    const pct = parseInt(process.env.SELL_PCT || "100");
    const targetPrice = process.env.TARGET_PRICE;
    const slippage = parseInt(process.env.SLIPPAGE || "500");
    const tipRate = parseInt(process.env.TIP || "0");
    const hours = parseInt(process.env.HOURS || "24");
    const expiry = Math.floor(Date.now() / 1000) + hours * 3600;

    if (!targetPrice) {
      console.error("Set TARGET_PRICE env var (USD per token, e.g. 0.000001)");
      process.exit(1);
    }

    const bal = await token.balanceOf(signer.address);
    const amount = bal * BigInt(pct) / 100n;

    console.log(`创建卖单: ${fmt(amount)} ${symbol} (${pct}%)`);
    console.log(`目标价: $${targetPrice}  滑点: ${slippage/100}%  有效期: ${hours}h`);

    // approve token to LimitOrderBook
    const allowance = await token.allowance(signer.address, LIMIT_ORDER);
    if (allowance < amount) {
      console.log("Approving token to LimitOrderBook...");
      await (await token.approve(LIMIT_ORDER, hre.ethers.MaxUint256, GAS)).wait();
    }

    const tx = await book.createSellOrder(
      TOKEN,
      amount,
      hre.ethers.parseEther(targetPrice),
      slippage,
      tipRate,
      expiry,
      GAS
    );
    console.log("TX:", tx.hash);
    const r = await tx.wait();
    for (const log of r.logs) {
      try {
        const p = book.interface.parseLog(log);
        if (p?.name === "OrderCreated") {
          console.log(`订单创建成功: #${p.args.orderId}`);
        }
      } catch {}
    }
  }

  else if (cmd === "cancel") {
    const orderId = parseInt(process.env.ORDER_ID);
    if (isNaN(orderId)) {
      console.error("Set ORDER_ID env var");
      process.exit(1);
    }

    const o = await book.getOrder(orderId);
    console.log(`取消订单 #${orderId} (${o.isBuy ? "BUY" : "SELL"})`);

    const tx = await book.cancelOrder(orderId, GAS);
    console.log("TX:", tx.hash);
    await tx.wait();
    console.log("订单已取消");
  }

  else if (cmd === "execute") {
    const orderId = parseInt(process.env.ORDER_ID);
    if (isNaN(orderId)) {
      console.error("Set ORDER_ID env var");
      process.exit(1);
    }

    const [executable, currentPrice] = await book.checkExecutable(orderId);
    const o = await book.getOrder(orderId);
    console.log(`订单 #${orderId}: ${o.isBuy ? "BUY" : "SELL"}`);
    console.log(`目标价: $${hre.ethers.formatEther(o.targetPrice)}`);
    console.log(`当前价: $${hre.ethers.formatEther(currentPrice)}`);
    console.log(`可执行: ${executable}`);

    if (!executable) {
      console.log("价格条件未满足，无法执行");
      return;
    }

    const tx = await book.executeOrder(orderId, GAS);
    console.log("TX:", tx.hash);
    const r = await tx.wait();
    for (const log of r.logs) {
      try {
        const p = book.interface.parseLog(log);
        if (p?.name === "OrderExecuted") {
          console.log(`执行成功: amountOut=${p.args.amountOut} fee=${p.args.fee}`);
        }
      } catch {}
    }
  }

  else if (cmd === "check") {
    const orderId = parseInt(process.env.ORDER_ID);
    if (isNaN(orderId)) {
      console.error("Set ORDER_ID env var");
      process.exit(1);
    }

    const [executable, currentPrice] = await book.checkExecutable(orderId);
    const o = await book.getOrder(orderId);
    console.log(`订单 #${orderId}: ${o.isBuy ? "BUY" : "SELL"}`);
    console.log(`目标价: $${hre.ethers.formatEther(o.targetPrice)}`);
    console.log(`当前价: $${hre.ethers.formatEther(currentPrice)}`);
    console.log(`可执行: ${executable}`);
  }

  else if (cmd === "pending") {
    const limit = parseInt(process.env.LIMIT || "50");
    const ids = await book.getPendingOrders(0, limit);
    console.log(`Pending orders (${ids.length}):`);
    for (const id of ids) {
      const o = await book.getOrder(id);
      const side = o.isBuy ? "BUY" : "SELL";
      const amt = o.isBuy ? fmtE(o.amount) + " BNB" : fmt(o.amount) + " " + symbol;
      const target = hre.ethers.formatEther(o.targetPrice);
      const [executable, currentPrice] = await book.checkExecutable(id);
      const current = hre.ethers.formatEther(currentPrice);
      console.log(`  #${id}: ${side} ${amt} @ $${target} (now: $${current}) ${executable ? "✓ READY" : ""}`);
    }
  }

  else if (cmd === "setup") {
    console.log("设置执行者...");
    const tx = await book.setExecutor(signer.address, true, GAS);
    await tx.wait();
    console.log(`${signer.address} 已设置为执行者`);
  }

  else {
    console.log("Commands: info, price, create-buy, create-sell, cancel, execute, check, pending, setup");
  }
}

main().then(() => process.exit(0)).catch(e => { console.error(e.shortMessage || e.message.slice(0, 300)); process.exit(1); });
