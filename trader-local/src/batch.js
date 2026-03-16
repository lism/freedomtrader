// Freedom Trader 本地系统 - 批量交易
// 从 Chrome 扩展 batch.js 移植，去掉 DOM 依赖

import { formatUnits, parseUnits } from 'viem';
import { state } from './state.js';
import { normalizeAmount, getTradeAmountDecimals } from './utils.js';
import { buy as bscBuy, sell as bscSell } from './trading-bsc.js';
import { solBuy, solSell } from './trading-sol.js';
import { loadConfig } from './config.js';

function isSol() { return state.currentChain === 'sol'; }
function quoteSymbol() { return isSol() ? 'SOL' : 'BNB'; }
function getBuyDecimals() { return getTradeAmountDecimals(state.currentChain, 'buy', state.tokenInfo.decimals); }
function getSellDecimals() { return getTradeAmountDecimals(state.currentChain, 'sell', state.tokenInfo.decimals); }

function getActiveWallets() {
  if (isSol()) {
    return state.solActiveWalletIds.filter(id => state.solAddresses.has(id));
  }
  return state.activeWalletIds.filter(id => state.walletClients.has(id));
}

function getSlippage() {
  const config = loadConfig();
  return parseFloat(config.slippage) || 15;
}

function getGasPrice() {
  const config = loadConfig();
  if (isSol()) {
    const solVal = parseFloat(config.solPriorityFee);
    return Math.floor((solVal > 0 ? solVal : 0.0001) * 1e9);
  }
  return parseFloat(config.gasPrice) || 3;
}

function getJitoTip() {
  const config = loadConfig();
  const solVal = parseFloat(config.solJitoTip);
  if (isNaN(solVal) || solVal < 0) return 0;
  return Math.floor(solVal * 1e9);
}

function doBuy(id, tokenAddr, amountStr) {
  const normalizedAmount = normalizeAmount(amountStr, getBuyDecimals());
  if (isSol()) {
    return solBuy(id, tokenAddr, parseFloat(normalizedAmount), getSlippage(), {
      priorityFee: getGasPrice(),
      jitoTip: getJitoTip(),
    });
  }
  return bscBuy(id, tokenAddr, normalizedAmount, getGasPrice());
}

function doSell(id, tokenAddr, amountStr) {
  if (isSol()) {
    let solSellAmount = amountStr;
    if (!amountStr.endsWith('%')) {
      const dec = state.tokenInfo.decimals || 6;
      const normalizedAmount = normalizeAmount(amountStr, getSellDecimals());
      solSellAmount = parseUnits(normalizedAmount, dec).toString();
    }
    return solSell(id, tokenAddr, solSellAmount, getSlippage(), {
      priorityFee: getGasPrice(),
      jitoTip: getJitoTip(),
    });
  }
  return bscSell(id, tokenAddr, normalizeAmount(amountStr, getSellDecimals()), getGasPrice());
}

export async function executeBatchTrade(tokenAddr, amountStr, mode) {
  const normalizedAmount = normalizeAmount(amountStr, state.tradeMode === 'sell' ? getSellDecimals() : getBuyDecimals());
  if (!tokenAddr || !state.lpInfo.hasLP) {
    console.error('❌ 请输入有效的代币地址');
    return;
  }
  const amount = parseFloat(normalizedAmount);
  if (!normalizedAmount || amount <= 0) {
    console.error('❌ 请输入数量');
    return;
  }

  const activeWallets = getActiveWallets();
  if (activeWallets.length === 0) {
    console.error('❌ 没有可用的钱包');
    return;
  }

  const modeLabel = mode === 'buy' ? '买入' : '卖出';
  const batchT0 = performance.now();
  console.log(`\n🔄 准备${modeLabel} (${activeWallets.length} 个钱包)...`);

  try {
    const promises = activeWallets.map(id =>
      mode === 'buy' ? doBuy(id, tokenAddr, normalizedAmount) : doSell(id, tokenAddr, normalizedAmount)
    );

    const results = await Promise.allSettled(promises);
    const batchElapsed = ((performance.now() - batchT0) / 1000).toFixed(2);

    let success = 0, failed = 0;
    const timings = [];
    results.forEach((r, i) => {
      if (r.status === 'fulfilled' && r.value) {
        success++;
        timings.push(r.value);
        console.log(`  ✓ 钱包 ${activeWallets[i]}: ${r.value.txHash}`);
      } else {
        failed++;
        console.error(`  ✗ 钱包 ${activeWallets[i]}:`, r.reason?.message || r.reason);
      }
    });

    console.log(`\n📊 结果: 成功 ${success}, 失败 ${failed}, 耗时 ${batchElapsed}s`);

    if (failed === 0) {
      console.log(`🎉 全部${modeLabel}成功!`);
    } else if (success > 0) {
      console.log(`⚠️ 部分成功 ${success}/${success + failed}`);
    } else {
      console.log(`❌ 全部${modeLabel}失败`);
    }
  } catch (e) {
    console.error('批量交易失败:', e.message);
  }
}

export async function fastBuy(tokenAddr, amountStr) {
  const normalizedAmount = normalizeAmount(amountStr, getBuyDecimals());
  if (!tokenAddr || !state.lpInfo.hasLP) {
    console.error('❌ 请先检测代币');
    return;
  }
  if (parseFloat(normalizedAmount) <= 0) {
    console.error('❌ 请输入数量');
    return;
  }
  const activeWallets = getActiveWallets();
  if (activeWallets.length === 0) {
    console.error('❌ 没有可用的钱包');
    return;
  }

  const unit = quoteSymbol();
  const batchT0 = performance.now();
  console.log(`\n⚡ 快速买入 ${normalizedAmount} ${unit} × ${activeWallets.length}...`);

  try {
    const results = await Promise.allSettled(activeWallets.map(id => doBuy(id, tokenAddr, normalizedAmount)));
    const elapsed = ((performance.now() - batchT0) / 1000).toFixed(2);
    const ok = results.filter(r => r.status === 'fulfilled').length;
    const fail = results.length - ok;

    results.forEach((r, i) => {
      if (r.status === 'fulfilled') {
        console.log(`  ✓ 钱包 ${activeWallets[i]}: ${r.value.txHash}`);
      } else {
        console.error(`  ✗ 钱包 ${activeWallets[i]}:`, r.reason?.message);
      }
    });

    if (fail === 0) console.log(`\n🎉 买入成功 ${elapsed}s`);
    else if (ok > 0) console.log(`\n⚠️ 成功 ${ok} / 失败 ${fail}`);
    else console.log('\n❌ 买入全部失败');
  } catch (e) {
    console.error('快速买入失败:', e.message);
  }
}

export async function fastSell(tokenAddr, pct) {
  if (!tokenAddr || !state.lpInfo.hasLP) {
    console.error('❌ 请先检测代币');
    return;
  }
  if (!state.tokenInfo.address) {
    console.error('❌ 请先检测代币');
    return;
  }
  const activeWallets = getActiveWallets();
  if (activeWallets.length === 0) {
    console.error('❌ 没有可用的钱包');
    return;
  }

  const batchT0 = performance.now();
  console.log(`\n⚡ 快速卖出 ${pct}% × ${activeWallets.length}...`);

  try {
    let sellPromises;
    if (isSol()) {
      sellPromises = activeWallets.map(id => doSell(id, tokenAddr, `${pct}%`));
    } else {
      sellPromises = activeWallets.map(async (id) => {
        const bal = state.tokenBalances.get(id) || 0n;
        if (bal <= 0n) throw new Error('余额为零');
        const amt = (bal * BigInt(pct)) / 100n;
        const amountStr = formatUnits(amt, state.tokenInfo.decimals);
        return doSell(id, tokenAddr, amountStr);
      });
    }
    const results = await Promise.allSettled(sellPromises);
    const elapsed = ((performance.now() - batchT0) / 1000).toFixed(2);
    const ok = results.filter(r => r.status === 'fulfilled').length;
    const fail = results.length - ok;

    results.forEach((r, i) => {
      if (r.status === 'fulfilled') {
        console.log(`  ✓ 钱包 ${activeWallets[i]}: ${r.value.txHash}`);
      } else {
        console.error(`  ✗ 钱包 ${activeWallets[i]}:`, r.reason?.message);
      }
    });

    if (fail === 0) console.log(`\n🎉 卖出成功 ${elapsed}s`);
    else if (ok > 0) console.log(`\n⚠️ 成功 ${ok} / 失败 ${fail}`);
    else console.log('\n❌ 卖出全部失败');
  } catch (e) {
    console.error('快速卖出失败:', e.message);
  }
}
