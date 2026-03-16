const hre = require("hardhat");
require("dotenv").config();

const API_BASE = process.env.BSCSCAN_API_BASE || "https://api.bscscan.com/api";
const API_KEY = process.env.BSCSCAN_API_KEY || "";
const ROUTER = (process.env.ROUTER_ADDRESS || "0x444444444444147c48E01D3669260E33d8b33c93").toLowerCase();
const DEV = (process.env.DEV_ADDRESS || "0x2De78dd769679119b4B3a158235678df92E98319").toLowerCase();
const START_BLOCK = Number(process.env.START_BLOCK || "1");
const END_BLOCK = Number(process.env.END_BLOCK || "99999999");
const PAGE_SIZE = Math.max(1, Math.min(Number(process.env.PAGE_SIZE || "1000"), 10000));
const TOP = Math.max(1, Number(process.env.TOP || "50"));
const ONLY = (process.env.ONLY || "all").toLowerCase();
const FORMAT = (process.env.FORMAT || "table").toLowerCase();

const ROUTER_IFACE = new hre.ethers.Interface([
  "function buy(address token, uint256 amountOutMin, uint256 tipRate, uint256 deadline)",
  "function sell(address token, uint256 amountIn, uint256 amountOutMin, uint256 tipRate, uint256 deadline)",
]);

function assertRuntime() {
  if (typeof fetch !== "function") {
    throw new Error("当前 Node.js 不支持 fetch，请使用 Node 18+");
  }
  if (!["all", "buy", "sell"].includes(ONLY)) {
    throw new Error(`ONLY 仅支持 all | buy | sell，当前为: ${ONLY}`);
  }
  if (!["table", "json", "csv"].includes(FORMAT)) {
    throw new Error(`FORMAT 仅支持 table | json | csv，当前为: ${FORMAT}`);
  }
}

function lower(addr) {
  return String(addr || "").toLowerCase();
}

function isSuccessTx(tx) {
  if (tx.txreceipt_status != null) return tx.txreceipt_status === "1";
  return tx.isError === "0";
}

function calcTip(amount, tipRate) {
  const rate = BigInt(tipRate);
  if (rate <= 0n) return 0n;
  return (amount * rate) / 10000n;
}

function formatBnb(wei) {
  return hre.ethers.formatEther(wei);
}

function shortBnb(wei, digits = 8) {
  const text = formatBnb(wei);
  const [intPart, frac = ""] = text.split(".");
  if (!frac) return text;
  const trimmed = frac.slice(0, digits).replace(/0+$/, "");
  return trimmed ? `${intPart}.${trimmed}` : intPart;
}

function pad(text, width, dir = "end") {
  const s = String(text);
  return dir === "start" ? s.padStart(width, " ") : s.padEnd(width, " ");
}

async function apiGet(params) {
  const qs = new URLSearchParams({
    ...params,
    apikey: API_KEY,
  });
  const url = `${API_BASE}?${qs.toString()}`;
  const res = await fetch(url);
  if (!res.ok) {
    throw new Error(`BscScan 请求失败: HTTP ${res.status}`);
  }
  const data = await res.json();
  if (data.status === "0") {
    const message = `${data.message || ""} ${data.result || ""}`.trim();
    if (/No transactions found/i.test(message)) return [];
    throw new Error(`BscScan 返回错误: ${message}`);
  }
  if (!Array.isArray(data.result)) {
    throw new Error("BscScan 返回格式异常");
  }
  return data.result;
}

async function fetchAll(action, address, label) {
  const rows = [];
  for (let page = 1; ; page++) {
    const batch = await apiGet({
      module: "account",
      action,
      address,
      startblock: String(START_BLOCK),
      endblock: String(END_BLOCK),
      page: String(page),
      offset: String(PAGE_SIZE),
      sort: "asc",
    });
    rows.push(...batch);
    console.log(`[${label}] page=${page} fetched=${batch.length} total=${rows.length}`);
    if (batch.length < PAGE_SIZE) break;
  }
  return rows;
}

function parseRouterTx(tx) {
  if (lower(tx.to) !== ROUTER) return null;
  if (!isSuccessTx(tx)) return null;
  try {
    const parsed = ROUTER_IFACE.parseTransaction({
      data: tx.input,
      value: BigInt(tx.value || "0"),
    });
    if (!parsed || !["buy", "sell"].includes(parsed.name)) return null;
    return {
      hash: lower(tx.hash),
      user: lower(tx.from),
      blockNumber: Number(tx.blockNumber),
      timeStamp: Number(tx.timeStamp),
      type: parsed.name,
      value: BigInt(tx.value || "0"),
      tipRate: BigInt(parsed.args.tipRate),
    };
  } catch {
    return null;
  }
}

function makeEmptyStat(address) {
  return {
    address,
    buyTip: 0n,
    sellTip: 0n,
    totalTip: 0n,
    buyTxCount: 0,
    sellTxCount: 0,
    totalTxCount: 0,
  };
}

function addTip(stats, address, kind, amount) {
  if (amount <= 0n) return;
  const key = lower(address);
  const current = stats.get(key) || makeEmptyStat(key);
  if (kind === "buy") {
    current.buyTip += amount;
    current.buyTxCount += 1;
  } else {
    current.sellTip += amount;
    current.sellTxCount += 1;
  }
  current.totalTip += amount;
  current.totalTxCount += 1;
  stats.set(key, current);
}

function printTable(rows, summary) {
  const header = [
    pad("#", 4, "start"),
    pad("address", 44),
    pad("total(BNB)", 14, "start"),
    pad("buy(BNB)", 14, "start"),
    pad("sell(BNB)", 14, "start"),
    pad("txs", 6, "start"),
  ].join("  ");

  console.log("");
  console.log(header);
  console.log("-".repeat(header.length));
  rows.forEach((row, idx) => {
    console.log([
      pad(idx + 1, 4, "start"),
      pad(row.address, 44),
      pad(shortBnb(row.totalTip), 14, "start"),
      pad(shortBnb(row.buyTip), 14, "start"),
      pad(shortBnb(row.sellTip), 14, "start"),
      pad(row.totalTxCount, 6, "start"),
    ].join("  "));
  });

  console.log("");
  console.log(`地址数: ${summary.addressCount}`);
  console.log(`总小费: ${formatBnb(summary.totalTip)} BNB`);
  console.log(`买入小费: ${formatBnb(summary.buyTip)} BNB`);
  console.log(`卖出小费: ${formatBnb(summary.sellTip)} BNB`);
  console.log(`买入笔数: ${summary.buyTxCount}`);
  console.log(`卖出笔数: ${summary.sellTxCount}`);
}

function printCsv(rows) {
  console.log("address,total_bnb,buy_bnb,sell_bnb,total_txs,buy_txs,sell_txs");
  for (const row of rows) {
    console.log([
      row.address,
      formatBnb(row.totalTip),
      formatBnb(row.buyTip),
      formatBnb(row.sellTip),
      row.totalTxCount,
      row.buyTxCount,
      row.sellTxCount,
    ].join(","));
  }
}

async function main() {
  assertRuntime();

  if (!API_KEY) {
    console.warn("未检测到 BSCSCAN_API_KEY，将尝试匿名请求，速率可能较低。");
  }

  console.log(`Router: ${ROUTER}`);
  console.log(`Dev tip wallet: ${DEV}`);
  console.log(`Blocks: ${START_BLOCK} -> ${END_BLOCK}`);
  console.log(`ONLY=${ONLY} FORMAT=${FORMAT} TOP=${TOP}`);

  const normalTxs = await fetchAll("txlist", ROUTER, "router-tx");
  const parsedTxs = normalTxs
    .map(parseRouterTx)
    .filter(Boolean)
    .filter((tx) => ONLY === "all" || tx.type === ONLY);

  console.log(`[router-tx] matched buy/sell txs: ${parsedTxs.length}`);

  const stats = new Map();
  const sellTxs = [];
  let buyTipSum = 0n;

  for (const tx of parsedTxs) {
    if (tx.type === "buy") {
      const tip = calcTip(tx.value, tx.tipRate);
      if (tip > 0n) {
        addTip(stats, tx.user, "buy", tip);
        buyTipSum += tip;
      }
    } else if (tx.type === "sell") {
      sellTxs.push(tx);
    }
  }

  let sellTipSum = 0n;
  if (ONLY !== "buy" && sellTxs.length > 0) {
    const sellHashSet = new Set(sellTxs.map((tx) => tx.hash));
    const sellMetaByHash = new Map(sellTxs.map((tx) => [tx.hash, tx]));
    const internalTxs = await fetchAll("txlistinternal", DEV, "dev-internal");
    const sellTipByHash = new Map();

    for (const itx of internalTxs) {
      if (lower(itx.to) !== DEV) continue;
      const hash = lower(itx.hash);
      if (!sellHashSet.has(hash)) continue;
      const value = BigInt(itx.value || "0");
      if (value <= 0n) continue;
      sellTipByHash.set(hash, (sellTipByHash.get(hash) || 0n) + value);
    }

    for (const [hash, amount] of sellTipByHash.entries()) {
      const meta = sellMetaByHash.get(hash);
      if (!meta || amount <= 0n) continue;
      addTip(stats, meta.user, "sell", amount);
      sellTipSum += amount;
    }
  }

  const rows = [...stats.values()].sort((a, b) => {
    if (a.totalTip === b.totalTip) return a.address.localeCompare(b.address);
    return a.totalTip > b.totalTip ? -1 : 1;
  });
  const topRows = rows.slice(0, TOP);

  const summary = {
    router: ROUTER,
    dev: DEV,
    startBlock: START_BLOCK,
    endBlock: END_BLOCK,
    only: ONLY,
    addressCount: rows.length,
    totalTip: buyTipSum + sellTipSum,
    buyTip: buyTipSum,
    sellTip: sellTipSum,
    buyTxCount: rows.reduce((sum, row) => sum + row.buyTxCount, 0),
    sellTxCount: rows.reduce((sum, row) => sum + row.sellTxCount, 0),
  };

  if (FORMAT === "json") {
    console.log(JSON.stringify({
      ...summary,
      totalTipBnb: formatBnb(summary.totalTip),
      buyTipBnb: formatBnb(summary.buyTip),
      sellTipBnb: formatBnb(summary.sellTip),
      rows: topRows.map((row) => ({
        ...row,
        totalTipBnb: formatBnb(row.totalTip),
        buyTipBnb: formatBnb(row.buyTip),
        sellTipBnb: formatBnb(row.sellTip),
      })),
    }, null, 2));
    return;
  }

  if (FORMAT === "csv") {
    printCsv(topRows);
    return;
  }

  printTable(topRows, summary);
}

main()
  .then(() => process.exit(0))
  .catch((err) => {
    console.error(err.shortMessage || err.message || err);
    process.exit(1);
  });
