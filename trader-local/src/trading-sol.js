// Freedom Trader 本地系统 - SOL 交易封装
// 从 Chrome 扩展 sol-trading.js 移植

import { state } from './state.js';
import { getConnection } from './sol/connection.js';
import { detectToken, buy, sell } from './sol/trading.js';
import { loadConfig } from './config.js';

function ensureConnection() {
  const conn = getConnection();
  if (!conn) throw new Error('SOL RPC 未初始化，请检查设置');
  return conn;
}

function getSolTipBps() {
  const config = loadConfig();
  const rate = config.tipRate;
  if (rate == null || rate === '' || rate === 0) return 0;
  const pct = Math.max(0, Math.min(5, Number(rate)));
  return Math.floor(pct * 100);
}

export async function solDetectToken(mintAddress) {
  ensureConnection();
  return detectToken(mintAddress);
}

function getCachedDetectResult() {
  return state.lpInfo?.solDetectResult || null;
}

export async function solBuy(walletId, mintAddr, solAmount, slippage, opts = {}) {
  ensureConnection();
  const publicKey = state.solAddresses.get(walletId);
  if (!publicKey) throw new Error('SOL 钱包未初始化');

  const config = loadConfig();
  const priorityFee = opts.priorityFee ?? Math.floor((config.solPriorityFee || 0.0001) * 1e9);
  const jitoTip = opts.jitoTip ?? Math.floor((config.solJitoTip || 0.0001) * 1e9);

  const result = await buy(walletId, publicKey, mintAddr, solAmount, slippage, {
    priorityFeeLamports: priorityFee,
    computeUnits: 200000,
    tipBps: getSolTipBps(),
    jitoTipLamports: jitoTip,
    detectResult: getCachedDetectResult(),
  });

  return {
    txHash: result.signature,
    buildMs: result.buildMs,
    sendMs: result.sendMs,
    confirmMs: result.confirmMs,
    totalMs: result.elapsed,
  };
}

export async function solSell(walletId, mintAddr, amountOrPct, slippage, opts = {}) {
  ensureConnection();
  const publicKey = state.solAddresses.get(walletId);
  if (!publicKey) throw new Error('SOL 钱包未初始化');

  const config = loadConfig();
  const priorityFee = opts.priorityFee ?? Math.floor((config.solPriorityFee || 0.0001) * 1e9);
  const jitoTip = opts.jitoTip ?? Math.floor((config.solJitoTip || 0.0001) * 1e9);

  const result = await sell(walletId, publicKey, mintAddr, amountOrPct, slippage, {
    priorityFeeLamports: priorityFee,
    computeUnits: 200000,
    tipBps: getSolTipBps(),
    jitoTipLamports: jitoTip,
    detectResult: getCachedDetectResult(),
  });

  return {
    txHash: result.signature,
    buildMs: result.buildMs,
    sendMs: result.sendMs,
    confirmMs: result.confirmMs,
    totalMs: result.elapsed,
  };
}
