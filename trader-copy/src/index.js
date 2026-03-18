import 'dotenv/config';
import { createPublicClient, createWalletClient, formatUnits, http, parseUnits, pad, webSocket } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { bsc } from 'viem/chains';

import { createClient, listBscWallets } from '../../trader-local/src/wallet-bsc.js';
import { detectBscToken } from '../../trader-local/src/token-bsc.js';
import { buy as bscBuy, sell as bscSell, loadApprovedTokens } from '../../trader-local/src/trading-bsc.js';
import { state } from '../../trader-local/src/state.js';
import { FREEDOM_ROUTER, ROUTER_ABI } from '../../trader-local/src/constants.js';

const TRANSFER_TOPIC = '0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef';
const WBNB = '0xbb4cdb9cbd36b01bd1cbaebf2de08d9173bc095c';

const MASTERS = (process.env.MASTER_WALLETS || '')
  .split(',')
  .map((wallet) => wallet.trim().toLowerCase())
  .filter(Boolean);

const SIMULATION_MODE = process.env.SIMULATION_MODE === 'true';
const BUY_AMOUNT = process.env.FIXED_BUY_AMOUNT || '0.01';
const SELL_PERCENT = process.env.SELL_PERCENT || '100';
const SLIPPAGE = Number.parseFloat(process.env.SLIPPAGE || '5') || 5;
const POLL_INTERVAL_MS = Number.parseInt(process.env.POLL_INTERVAL_MS || '3000', 10);
const START_BLOCK_LOOKBACK = BigInt(process.env.START_BLOCK_LOOKBACK || '2');
const MAX_PROCESSED_EVENTS = Number.parseInt(process.env.MAX_PROCESSED_EVENTS || '5000', 10);
const MAX_LOG_BLOCK_RANGE = BigInt(process.env.MAX_LOG_BLOCK_RANGE || '5');

const simulationStats = {
  totalTrades: 0,
  profitableTrades: 0,
  losingTrades: 0,
  totalInvested: 0,
  totalReturned: 0,
  trades: [],
};
const simulatedPositions = new Map();

const processedEvents = new Set();
const processedEventOrder = [];

let actionQueue = Promise.resolve();
let pollingTimer = null;
let lastScannedBlock = null;
let pollingInFlight = false;

function toHexBlock(blockNumber) {
  return `0x${blockNumber.toString(16)}`;
}

async function getTransferLogs(fromBlock, toBlock, topics) {
  return state.publicClient.request({
    method: 'eth_getLogs',
    params: [{
      fromBlock: toHexBlock(fromBlock),
      toBlock: toHexBlock(toBlock),
      topics,
    }],
  });
}

async function collectActionsForRange(fromBlock, toBlock, masterTopics) {
  const [buyLogs, sellLogs] = await Promise.all([
    getTransferLogs(fromBlock, toBlock, [TRANSFER_TOPIC, null, masterTopics]),
    getTransferLogs(fromBlock, toBlock, [TRANSFER_TOPIC, masterTopics]),
  ]);

  const actions = [];

  for (const log of buyLogs) {
    const token = log.address.toLowerCase();
    if (token === WBNB) continue;

    const eventId = getEventId(log, 'buy');
    if (!rememberProcessed(eventId)) continue;

    actions.push({
      side: 'buy',
      token,
      txHash: log.transactionHash,
      blockNumber: BigInt(log.blockNumber),
      logIndex: BigInt(log.logIndex),
    });
  }

  for (const log of sellLogs) {
    const token = log.address.toLowerCase();
    if (token === WBNB) continue;

    const eventId = getEventId(log, 'sell');
    if (!rememberProcessed(eventId)) continue;

    actions.push({
      side: 'sell',
      token,
      txHash: log.transactionHash,
      blockNumber: BigInt(log.blockNumber),
      logIndex: BigInt(log.logIndex),
    });
  }

  actions.sort((a, b) => {
    if (a.blockNumber === b.blockNumber) {
      return Number(a.logIndex - b.logIndex);
    }
    return a.blockNumber < b.blockNumber ? -1 : 1;
  });

  return actions;
}

function rememberProcessed(eventId) {
  if (processedEvents.has(eventId)) return false;

  processedEvents.add(eventId);
  processedEventOrder.push(eventId);

  while (processedEventOrder.length > MAX_PROCESSED_EVENTS) {
    const removed = processedEventOrder.shift();
    if (removed) processedEvents.delete(removed);
  }

  return true;
}

function enqueueAction(handler) {
  actionQueue = actionQueue
    .then(async () => {
      try {
        await handler();
      } catch (error) {
        console.error('[COPY] 执行队列任务失败:', error.message);
      }
    })
    .catch((error) => {
      console.error('[COPY] 队列异常:', error.message);
    });

  return actionQueue;
}

function formatTokenAmount(amount, decimals) {
  try {
    return Number.parseFloat(formatUnits(amount, decimals)).toFixed(6);
  } catch {
    return amount.toString();
  }
}

async function snapshotUnrealizedPositions() {
  const positions = [];
  const slippageBps = Math.floor((100 - SLIPPAGE) * 100);

  for (const position of simulatedPositions.values()) {
    let estimatedValueWei = 0n;
    try {
      estimatedValueWei = await getSellQuote(position.tokenAddress, position.tokenAmountWei, slippageBps) || 0n;
    } catch {
      estimatedValueWei = 0n;
    }

    const unrealizedPnlWei = estimatedValueWei - position.costWei;
    const unrealizedRoi = position.costWei > 0n
      ? Number(unrealizedPnlWei * 10000n / position.costWei) / 100
      : 0;

    positions.push({
      ...position,
      estimatedValueWei,
      unrealizedPnlWei,
      unrealizedRoi,
    });
  }

  return positions;
}

function getSimulatedPosition(tokenAddress) {
  return simulatedPositions.get(tokenAddress.toLowerCase());
}

function upsertSimulatedPosition(tokenAddress, patch) {
  const key = tokenAddress.toLowerCase();
  const current = simulatedPositions.get(key) || {
    tokenAddress: key,
    symbol: patch.symbol || 'UNKNOWN',
    decimals: patch.decimals ?? 18,
    tokenAmountWei: 0n,
    costWei: 0n,
    buyCount: 0,
  };

  const next = { ...current, ...patch };
  if (next.tokenAmountWei <= 0n || next.costWei <= 0n) {
    simulatedPositions.delete(key);
    return null;
  }

  simulatedPositions.set(key, next);
  return next;
}

function getEventId(log, side) {
  const blockNumber = log.blockNumber != null ? log.blockNumber.toString() : 'pending';
  const logIndex = log.logIndex != null ? log.logIndex.toString() : '0';
  return `${blockNumber}:${log.transactionHash}:${logIndex}:${side}`;
}

async function init() {
  console.log('--- 启动跟单系统 (Trader Copy) ---');

  if (MASTERS.length === 0) {
    console.error('❌ 请在 .env 中设置 MASTER_WALLETS');
    process.exit(1);
  }

  const pk = process.env.PRIVATE_KEY;
  if (!pk) {
    console.error('❌ 请在 .env 中设置 PRIVATE_KEY');
    process.exit(1);
  }

  const rpcUrl = process.env.RPC_URL || 'https://bsc-dataseed.bnbchain.org';
  const rpcWss = (process.env.RPC_WSS || '').trim();
  createClient(rpcUrl);

  if (rpcWss) {
    state.publicClient = createPublicClient({
      chain: bsc,
      transport: webSocket(rpcWss),
    });
  }

  const key = pk.startsWith('0x') ? pk : `0x${pk}`;
  const account = privateKeyToAccount(key);
  const client = createWalletClient({
    chain: bsc,
    transport: http(rpcUrl),
    account,
  });

  const walletId = 'copy-wallet';
  state.walletClients.set(walletId, { client, account });
  state.wallets = [{ id: walletId, name: '跟单主钱包' }];
  state.activeWalletIds = [walletId];

  loadApprovedTokens();

  const activeWallets = listBscWallets().filter((wallet) => wallet.active);
  if (activeWallets.length === 0) {
    console.error('❌ trader-local 中没有可用的激活 BSC 钱包');
    process.exit(1);
  }

  console.log(`[COPY] 本地钱包: ${activeWallets[0].address}`);
  console.log(`[COPY] 跟单目标: ${MASTERS.join(', ')}`);
  console.log(`[COPY] 模式: ${SIMULATION_MODE ? '模拟' : '实盘'}`);
  console.log(`[COPY] RPC: ${rpcWss || rpcUrl}`);

  const currentBlock = await state.publicClient.getBlockNumber();
  lastScannedBlock = currentBlock >= START_BLOCK_LOOKBACK
    ? currentBlock - START_BLOCK_LOOKBACK + 1n
    : 0n;

  console.log(`[COPY] 从区块 ${lastScannedBlock.toString()} 开始轮询，间隔 ${POLL_INTERVAL_MS}ms`);

  await pollTransfers();
  pollingTimer = setInterval(() => {
    pollTransfers().catch((error) => {
      console.error('[COPY] 轮询失败:', error.message);
    });
  }, POLL_INTERVAL_MS);
}

async function pollTransfers() {
  if (pollingInFlight) {
    console.log('[COPY] 上一轮扫描仍在进行，跳过本次轮询');
    return;
  }

  pollingInFlight = true;

  try {
  const currentBlock = await state.publicClient.getBlockNumber();
  if (lastScannedBlock == null) {
    lastScannedBlock = currentBlock;
  }
  if (currentBlock < lastScannedBlock) {
    return;
  }

  const masterTopics = MASTERS.map((master) => pad(master));
  let cursor = lastScannedBlock;

  while (cursor <= currentBlock) {
    const toBlock = cursor + MAX_LOG_BLOCK_RANGE - 1n < currentBlock
      ? cursor + MAX_LOG_BLOCK_RANGE - 1n
      : currentBlock;

    console.log(`[COPY] 扫描区块 ${cursor.toString()} -> ${toBlock.toString()}`);

    const actions = await collectActionsForRange(cursor, toBlock, masterTopics);

    for (const action of actions) {
      const sideLabel = action.side === 'buy' ? '买入' : '卖出';
      console.log(`\n[COPY] 捕获到跟单账户${sideLabel}: ${action.token}`);
      console.log(`[COPY] TX: ${action.txHash}`);

      enqueueAction(async () => {
        if (action.side === 'buy') {
          await executeCopyBuy(action.token);
        } else {
          await executeCopySell(action.token);
        }
      });
    }

    cursor = toBlock + 1n;
  }

  lastScannedBlock = currentBlock + 1n;
  } finally {
    pollingInFlight = false;
  }
}

async function getBuyQuote(tokenAddr, amountBnb, minReceiveBps) {
  const amountIn = parseUnits(amountBnb.toString(), 18);

  try {
    const estimated = await state.publicClient.readContract({
      address: FREEDOM_ROUTER,
      abi: ROUTER_ABI,
      functionName: 'quoteBuy',
      args: [tokenAddr, amountIn],
    });
    return (estimated * BigInt(minReceiveBps)) / 10000n;
  } catch (error) {
    console.warn('[QUOTE] 无法获取买入报价:', error.message);
    return null;
  }
}

async function getSellQuote(tokenAddr, tokenAmount, minReceiveBps) {
  try {
    const estimated = await state.publicClient.readContract({
      address: FREEDOM_ROUTER,
      abi: ROUTER_ABI,
      functionName: 'quoteSell',
      args: [tokenAddr, tokenAmount],
    });
    return (estimated * BigInt(minReceiveBps)) / 10000n;
  } catch (error) {
    console.warn('[QUOTE] 无法获取卖出报价:', error.message);
    return null;
  }
}

async function simulateBuy(tokenAddress) {
  try {
    state.currentChain = 'bsc';
    await detectBscToken(tokenAddress);

    if (!state.lpInfo.hasLP && !state.lpInfo.isInternal) {
      console.log(`[SIM] ${state.tokenInfo.symbol || tokenAddress} 无流动性，跳过`);
      return null;
    }

    const amountBnb = Number.parseFloat(BUY_AMOUNT);
    const minReceiveBps = Math.floor((100 - SLIPPAGE) * 100);
    const investedBnbWei = parseUnits(BUY_AMOUNT, 18);

    const tokenAmount = await getBuyQuote(tokenAddress, amountBnb, minReceiveBps);
    if (!tokenAmount || tokenAmount <= 0n) {
      console.log(`[SIM] 无法获取 ${state.tokenInfo.symbol || tokenAddress} 的买入报价`);
      return null;
    }

    const estimatedExitBnbWei = await getSellQuote(tokenAddress, tokenAmount, minReceiveBps);
    const estimatedExitBnb = estimatedExitBnbWei ? Number(formatUnits(estimatedExitBnbWei, 18)) : 0;
    const estimatedRoi = estimatedExitBnbWei && investedBnbWei > 0n
      ? Number((estimatedExitBnbWei - investedBnbWei) * 10000n / investedBnbWei) / 100
      : 0;

    const existingPosition = getSimulatedPosition(tokenAddress);
    const position = upsertSimulatedPosition(tokenAddress, {
      symbol: state.tokenInfo.symbol || 'UNKNOWN',
      decimals: state.tokenInfo.decimals,
      tokenAmountWei: (existingPosition?.tokenAmountWei || 0n) + tokenAmount,
      costWei: (existingPosition?.costWei || 0n) + investedBnbWei,
      buyCount: (existingPosition?.buyCount || 0) + 1,
    });

    simulationStats.totalInvested += amountBnb;

    console.log(`[SIM] 买入 ${position.symbol} (${tokenAddress})`);
    console.log(`[SIM] 投入: ${amountBnb} BNB`);
    console.log(`[SIM] 预计获得: ${formatTokenAmount(tokenAmount, state.tokenInfo.decimals)} ${position.symbol}`);
    console.log(`[SIM] 当前建仓后持仓: ${formatTokenAmount(position.tokenAmountWei, position.decimals)} ${position.symbol}`);
    console.log(`[SIM] 当前持仓成本: ${formatTokenAmount(position.costWei, 18)} BNB`);
    console.log(`[SIM] 若立即全卖预计回收: ${estimatedExitBnb.toFixed(6)} BNB`);
    console.log(`[SIM] 若立即全卖预计 ROI: ${estimatedRoi.toFixed(2)}%`);

    return {
      token: position.symbol,
      tokenAddress,
      investedBnb: amountBnb,
      estimatedExitBnb,
      estimatedRoi,
      timestamp: new Date().toISOString(),
    };
  } catch (error) {
    console.error('[SIM] 模拟买入失败:', error.message);
    return null;
  }
}

async function executeCopyBuy(tokenAddress) {
  if (SIMULATION_MODE) {
    return simulateBuy(tokenAddress);
  }

  try {
    state.currentChain = 'bsc';
    await detectBscToken(tokenAddress);

    if (!state.lpInfo.hasLP && !state.lpInfo.isInternal) {
      console.log(`[COPY] ${state.tokenInfo.symbol || tokenAddress} 无流动性，跳过买入`);
      return;
    }

    const wallets = listBscWallets().filter((wallet) => wallet.active);
    const amount = process.env.FIXED_BUY_AMOUNT || '0.01';
    const gasPrice = Number.parseFloat(process.env.GAS_PRICE_GWEI || '3');

    console.log(`[COPY] 执行买入 ${state.tokenInfo.symbol || tokenAddress} (${tokenAddress}) | ${amount} BNB`);
    const result = await bscBuy(wallets[0].id, tokenAddress, amount, gasPrice);
    console.log(`[COPY] 买入成功: ${result.txHash}`);
  } catch (error) {
    console.error('[COPY] 跟单买入失败:', error.message);
  }
}

async function executeCopySell(tokenAddress) {
  if (SIMULATION_MODE) {
    try {
      state.currentChain = 'bsc';
      await detectBscToken(tokenAddress);

      const position = getSimulatedPosition(tokenAddress);
      if (!position || position.tokenAmountWei <= 0n || position.costWei <= 0n) {
        console.log(`[SIM] ${state.tokenInfo.symbol || tokenAddress} 无模拟持仓，跳过卖出收益计算`);
        return;
      }

      const percent = BigInt(process.env.SELL_PERCENT || '100');
      const minReceiveBps = Math.floor((100 - SLIPPAGE) * 100);
      const sellAmountWei = (position.tokenAmountWei * percent) / 100n;
      if (sellAmountWei <= 0n) {
        console.log(`[SIM] ${position.symbol} 卖出数量为 0，跳过`);
        return;
      }

      const bnbReturnedWei = await getSellQuote(tokenAddress, sellAmountWei, minReceiveBps);
      if (!bnbReturnedWei || bnbReturnedWei <= 0n) {
        console.log(`[SIM] 无法获取 ${position.symbol} 的卖出报价`);
        return;
      }

      const costBasisWei = (position.costWei * sellAmountWei) / position.tokenAmountWei;
      const realizedPnlWei = bnbReturnedWei - costBasisWei;
      const roi = costBasisWei > 0n
        ? Number(realizedPnlWei * 10000n / costBasisWei) / 100
        : 0;

      const remainingTokenWei = position.tokenAmountWei - sellAmountWei;
      const remainingCostWei = position.costWei - costBasisWei;
      upsertSimulatedPosition(tokenAddress, {
        ...position,
        tokenAmountWei: remainingTokenWei,
        costWei: remainingCostWei,
      });

      const tradeRecord = {
        token: position.symbol,
        tokenAddress,
        investedBnb: Number(formatUnits(costBasisWei, 18)),
        returnedBnb: Number(formatUnits(bnbReturnedWei, 18)),
        roi,
        percent: Number(percent),
        timestamp: new Date().toISOString(),
      };

      simulationStats.totalTrades += 1;
      simulationStats.totalReturned += tradeRecord.returnedBnb;
      simulationStats.trades.push(tradeRecord);

      if (roi >= 0) {
        simulationStats.profitableTrades += 1;
      } else {
        simulationStats.losingTrades += 1;
      }

      console.log(`[SIM] 卖出 ${position.symbol} (${tokenAddress}) | 仓位 ${percent}%`);
      console.log(`[SIM] 本次卖出数量: ${formatTokenAmount(sellAmountWei, position.decimals)} ${position.symbol}`);
      console.log(`[SIM] 本次成本: ${tradeRecord.investedBnb.toFixed(6)} BNB`);
      console.log(`[SIM] 本次回收: ${tradeRecord.returnedBnb.toFixed(6)} BNB`);
      console.log(`[SIM] 已实现 ROI: ${roi.toFixed(2)}%`);

      const remain = getSimulatedPosition(tokenAddress);
      if (remain) {
        console.log(`[SIM] 剩余持仓: ${formatTokenAmount(remain.tokenAmountWei, remain.decimals)} ${remain.symbol}`);
        console.log(`[SIM] 剩余成本: ${formatTokenAmount(remain.costWei, 18)} BNB`);
      } else {
        console.log(`[SIM] ${position.symbol} 模拟持仓已清空`);
      }
    } catch (error) {
      console.error('[SIM] 模拟卖出失败:', error.message);
    }
    return;
  }

  try {
    state.currentChain = 'bsc';
    await detectBscToken(tokenAddress);

    const wallets = listBscWallets().filter((wallet) => wallet.active);
    const percent = process.env.SELL_PERCENT || '100';
    const gasPrice = Number.parseFloat(process.env.GAS_PRICE_GWEI || '3');

    console.log(`[COPY] 执行卖出 ${state.tokenInfo.symbol || tokenAddress} (${tokenAddress}) | 仓位 ${percent}%`);
    const result = await bscSell(wallets[0].id, tokenAddress, `${percent}%`, gasPrice);
    console.log(`[COPY] 卖出成功: ${result.txHash}`);
  } catch (error) {
    console.error('[COPY] 跟单卖出失败:', error.message);
  }
}

async function printSimulationStats() {
  const unrealizedPositions = await snapshotUnrealizedPositions();
  const totalUnrealizedCost = unrealizedPositions.reduce((sum, position) => sum + position.costWei, 0n);
  const totalUnrealizedValue = unrealizedPositions.reduce((sum, position) => sum + position.estimatedValueWei, 0n);
  const totalUnrealizedPnl = totalUnrealizedValue - totalUnrealizedCost;
  const unrealizedRoi = totalUnrealizedCost > 0n
    ? Number(totalUnrealizedPnl * 10000n / totalUnrealizedCost) / 100
    : 0;

  if (simulationStats.totalTrades === 0) {
    console.log('\n[SIM] 暂无已实现收益统计');
    if (unrealizedPositions.length > 0) {
      console.log(`[SIM] 当前未平仓数量: ${unrealizedPositions.length}`);
      console.log(`[SIM] 未实现成本: ${formatTokenAmount(totalUnrealizedCost, 18)} BNB`);
      console.log(`[SIM] 未实现市值: ${formatTokenAmount(totalUnrealizedValue, 18)} BNB`);
      console.log(`[SIM] 未实现盈亏: ${formatTokenAmount(totalUnrealizedPnl, 18)} BNB (${unrealizedRoi.toFixed(2)}%)`);
      for (const position of unrealizedPositions) {
        console.log(
          `[SIM] 未平仓 ${position.symbol} | 数量 ${formatTokenAmount(position.tokenAmountWei, position.decimals)} | 成本 ${formatTokenAmount(position.costWei, 18)} BNB | 市值 ${formatTokenAmount(position.estimatedValueWei, 18)} BNB | 浮盈 ${formatTokenAmount(position.unrealizedPnlWei, 18)} BNB (${position.unrealizedRoi.toFixed(2)}%)`
        );
      }
    }
    return;
  }

  const winRate = simulationStats.totalTrades > 0
    ? ((simulationStats.profitableTrades / simulationStats.totalTrades) * 100).toFixed(2)
    : '0.00';

  const avgRoi = simulationStats.totalTrades > 0
    ? simulationStats.trades.reduce((sum, trade) => sum + trade.roi, 0) / simulationStats.totalTrades
    : 0;

  console.log('\n' + '='.repeat(50));
  console.log('[SIM] 模拟交易统计');
  console.log('='.repeat(50));
  console.log(`总交易数: ${simulationStats.totalTrades}`);
  console.log(`盈利交易: ${simulationStats.profitableTrades}`);
  console.log(`亏损交易: ${simulationStats.losingTrades}`);
  console.log(`胜率: ${winRate}%`);
  console.log(`总投入: ${simulationStats.totalInvested.toFixed(4)} BNB`);
  console.log(`总回收: ${simulationStats.totalReturned.toFixed(4)} BNB`);
  console.log(`平均 ROI: ${avgRoi.toFixed(2)}%`);
  console.log(`未平仓数量: ${simulatedPositions.size}`);
  console.log(`[SIM] 未实现成本: ${formatTokenAmount(totalUnrealizedCost, 18)} BNB`);
  console.log(`[SIM] 未实现市值: ${formatTokenAmount(totalUnrealizedValue, 18)} BNB`);
  console.log(`[SIM] 未实现盈亏: ${formatTokenAmount(totalUnrealizedPnl, 18)} BNB (${unrealizedRoi.toFixed(2)}%)`);
  console.log(`[SIM] 合计回收+持仓市值: ${(simulationStats.totalReturned + Number(formatUnits(totalUnrealizedValue, 18))).toFixed(4)} BNB`);
  console.log('='.repeat(50));

  simulationStats.trades.forEach((trade, index) => {
    console.log(
      `${index + 1}. ${trade.token} | 投入 ${trade.investedBnb} BNB | 回收 ${trade.returnedBnb.toFixed(6)} BNB | ROI ${trade.roi.toFixed(2)}%`
    );
  });

  if (unrealizedPositions.length > 0) {
    console.log('[SIM] 当前未平仓:');
    for (const position of unrealizedPositions) {
      console.log(
        `[SIM] ${position.symbol} | 数量 ${formatTokenAmount(position.tokenAmountWei, position.decimals)} | 成本 ${formatTokenAmount(position.costWei, 18)} BNB | 市值 ${formatTokenAmount(position.estimatedValueWei, 18)} BNB | 浮盈 ${formatTokenAmount(position.unrealizedPnlWei, 18)} BNB (${position.unrealizedRoi.toFixed(2)}%)`
      );
    }
  }
}

async function shutdown() {
  if (pollingTimer) {
    clearInterval(pollingTimer);
    pollingTimer = null;
  }

  console.log('\n[COPY] 跟单系统已停止');
  await printSimulationStats();
  process.exit(0);
}

process.on('SIGINT', () => {
  shutdown().catch((error) => {
    console.error('[COPY] 停止时打印统计失败:', error.message);
    process.exit(1);
  });
});
process.on('SIGTERM', () => {
  shutdown().catch((error) => {
    console.error('[COPY] 停止时打印统计失败:', error.message);
    process.exit(1);
  });
});

if (process.argv.includes('--test')) {
  const tokenIndex = process.argv.indexOf('--test') + 1;
  const testToken = process.argv[tokenIndex];

  if (testToken && testToken.startsWith('0x')) {
    const rpcUrl = process.env.RPC_URL || 'https://bsc-dataseed.bnbchain.org';
    createClient(rpcUrl);

    state.wallets = [];
    state.activeWalletIds = [];

    await simulateBuy(testToken);
    await printSimulationStats();
    process.exit(0);
  }
}

init().catch((error) => {
  console.error(error);
  process.exit(1);
});
