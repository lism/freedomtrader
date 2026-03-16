import { parseUnits } from 'viem';
import { FREEDOM_ROUTER, ROUTER_ABI, ERC20_ABI, HELPER3_ABI, TOKEN_MANAGER_V2, HELPER3, ZERO_ADDR, DEFAULT_TIP_RATE, ROUTE, ETH_SENTINEL } from './constants.js';
import { bscWriteContract } from './crypto.js';
import { state } from './state.js';
import { $, getTradeAmountDecimals, normalizeAmount } from './utils.js';

function _quoteAddr() { return state.quoteToken.address; }
function _isNativeQuote() { return _quoteAddr() === ETH_SENTINEL; }

const APPROVE_KEY = 'approvedTokens';
const MAX_UINT256 = BigInt('0xffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff');
const MAX_HALF = BigInt('0x7fffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff');
const approvalInFlight = new Map();

function markApproved(key) {
  state.approvedTokens.add(key);
  chrome.storage.local.set({ [APPROVE_KEY]: [...state.approvedTokens] });
}

function makeApproveKey(owner, tokenAddr, spender) {
  return `${owner}:${tokenAddr}:${spender}`.toLowerCase();
}

async function ensureApproved(walletId, ownerAddress, tokenAddr, spender, gasPrice, minAllowance, source) {
  const approveKey = makeApproveKey(ownerAddress, tokenAddr, spender);
  if (state.approvedTokens.has(approveKey)) {
    console.log(`[${source}] 缓存命中，跳过 approve`);
    return;
  }

  const pending = approvalInFlight.get(approveKey);
  if (pending) {
    console.log(`[${source}] 授权进行中，等待已有 approve`);
    await pending;
    return;
  }

  const run = (async () => {
    const allowance = await state.publicClient.readContract({
      address: tokenAddr, abi: ERC20_ABI, functionName: 'allowance',
      args: [ownerAddress, spender]
    });

    if (allowance >= minAllowance) {
      if (allowance >= MAX_HALF) markApproved(approveKey);
      console.log(`[${source}] 已有足够授权，跳过 approve`);
      return;
    }

    const res = await bscWriteContract(walletId, {
      address: tokenAddr, abi: ERC20_ABI, functionName: 'approve',
      args: [spender, MAX_UINT256],
      gas: 150000n, gasPrice: parseUnits(gasPrice.toString(), 9)
    });
    console.log(`[${source}] 自动 approve 给`, spender, ':', res.txHash);
    await state.publicClient.waitForTransactionReceipt({ hash: res.txHash, timeout: 120000 });
    markApproved(approveKey);
  })();

  approvalInFlight.set(approveKey, run);
  try {
    await run;
  } finally {
    approvalInFlight.delete(approveKey);
  }
}

export async function loadApprovedTokens() {
  const data = await chrome.storage.local.get([APPROVE_KEY]);
  const saved = data[APPROVE_KEY];
  if (Array.isArray(saved)) saved.forEach(k => state.approvedTokens.add(k));
  console.log(`[APPROVE] 已加载 ${state.approvedTokens.size} 条授权缓存`);
}

export function getSellApproveTarget() {
  if (state.lpInfo.approveTarget && state.lpInfo.approveTarget !== ZERO_ADDR) {
    return state.lpInfo.approveTarget;
  }
  if (state.lpInfo.isInternal) {
    return TOKEN_MANAGER_V2;
  }
  return FREEDOM_ROUTER;
}

export function getTipRate() {
  const raw = (state.config.tipRate != null && state.config.tipRate !== '') ? Number(state.config.tipRate) : DEFAULT_TIP_RATE;
  const pct = Math.max(0, Math.min(5, raw));
  return BigInt(Math.floor(pct * 100));
}

export async function refreshTipConfig() {
  const c = await chrome.storage.local.get(['tipRate']);
  if (c.tipRate != null) state.config.tipRate = c.tipRate;
}

function _isFourInternal() {
  const r = state.lpInfo.routeSource;
  return r === ROUTE.FOUR_INTERNAL_BNB || r === ROUTE.FOUR_INTERNAL_ERC20;
}

// Internal tokens can only sell to BNB; override quote when non-BNB selected
function _sellQuoteAddr() {
  return _isFourInternal() ? ETH_SENTINEL : _quoteAddr();
}

function _useRouterQuote() {
  return state.lpInfo.routeSource !== ROUTE.NONE;
}

async function _getQuoteBuy(tokenAddr, amt, slipBps) {
  if (_useRouterQuote()) {
    const estimated = await state.publicClient.readContract({
      address: FREEDOM_ROUTER, abi: ROUTER_ABI, functionName: 'quote',
      args: [_quoteAddr(), amt, tokenAddr]
    });
    return (estimated * slipBps) / 10000n;
  }
  if (state.lpInfo.isInternal && state.tokenInfo.address) {
    const result = await state.publicClient.readContract({
      address: HELPER3, abi: HELPER3_ABI, functionName: 'tryBuy',
      args: [tokenAddr, 0n, amt]
    });
    return (result[2] * slipBps) / 10000n;
  }
  throw new Error('无可用报价路径');
}

async function _getQuoteSell(tokenAddr, amt, slipBps) {
  const sellQ = _sellQuoteAddr();
  if (_useRouterQuote()) {
    const estimated = await state.publicClient.readContract({
      address: FREEDOM_ROUTER, abi: ROUTER_ABI, functionName: 'quote',
      args: [tokenAddr, amt, sellQ]
    });
    if (estimated <= 0n) throw new Error('预估卖出收益为零');
    return (estimated * slipBps) / 10000n;
  }
  if (state.lpInfo.isInternal && state.tokenInfo.address) {
    const result = await state.publicClient.readContract({
      address: HELPER3, abi: HELPER3_ABI, functionName: 'trySell',
      args: [tokenAddr, amt]
    });
    const netFunds = result[2] - result[3];
    if (netFunds <= 0n) throw new Error('预估卖出收益为零');
    return (netFunds * slipBps) / 10000n;
  }
  throw new Error('无可用报价路径');
}

export async function buy(walletId, tokenAddr, amountStr, gasPrice) {
  const wc = state.walletClients.get(walletId);
  if (!wc) throw new Error('钱包未初始化');
  await refreshTipConfig();

  const normalizedAmount = normalizeAmount(amountStr, getTradeAmountDecimals(state.currentChain, 'buy', state.tokenInfo.decimals));
  const qDec = state.quoteToken.decimals;
  const amt = parseUnits(normalizedAmount, qDec);
  if (amt <= 0n) throw new Error('数量太小');
  const tipRate = getTipRate();
  const slippage = parseFloat($('slippage')?.value) || 15;
  const slipBps = BigInt(Math.floor((100 - slippage) * 100));

  let amountOutMin;
  try {
    amountOutMin = await _getQuoteBuy(tokenAddr, amt, slipBps);
  } catch (e) {
    throw new Error('无法预估买入数量: ' + e.message);
  }

  const native = _isNativeQuote();
  if (!native) {
    await ensureApproved(walletId, wc.address, _quoteAddr(), FREEDOM_ROUTER, gasPrice, amt, 'BUY');
  }

  const t0 = performance.now();
  const deadline = BigInt(Math.floor(Date.now() / 1000) + 10);
  const qs = state.quoteToken.symbol;
  console.log('[BUY] token:', tokenAddr, 'amount:', normalizedAmount, qs, 'tipRate:', tipRate.toString(), 'amountOutMin:', amountOutMin.toString());

  const res = await bscWriteContract(walletId, {
    address: FREEDOM_ROUTER, abi: ROUTER_ABI, functionName: 'trade',
    args: [_quoteAddr(), tokenAddr, native ? 0n : amt, amountOutMin, tipRate, deadline],
    ...(native ? { value: amt } : {}),
    gas: 800000n, gasPrice: parseUnits(gasPrice.toString(), 9)
  });
  const txHash = res.txHash;

  const tSent = performance.now();
  console.log(`[BUY] txHash: ${txHash} | 发送耗时: ${((tSent - t0) / 1000).toFixed(2)}s`);

  const receipt = await state.publicClient.waitForTransactionReceipt({ hash: txHash, timeout: 120000 });
  const tConfirm = performance.now();

  if (receipt.status !== 'success') throw new Error('交易失败: ' + txHash);
  console.log(`[BUY] ✓ 确认 | 等待: ${((tConfirm - tSent) / 1000).toFixed(2)}s | 总计: ${((tConfirm - t0) / 1000).toFixed(2)}s`);

  // Pre-approve for both internal + external sell targets in parallel
  const targets = new Set([getSellApproveTarget(), FREEDOM_ROUTER]);
  await Promise.all([...targets].map(t =>
    ensureApproved(walletId, wc.address, tokenAddr, t, gasPrice, MAX_HALF, 'BUY')
      .catch(e => console.warn('[BUY] 自动 approve 失败:', e.message))
  ));

  return { txHash, sendMs: tSent - t0, confirmMs: tConfirm - tSent, totalMs: tConfirm - t0 };
}

export async function sell(walletId, tokenAddr, amountStr, gasPrice) {
  const wc = state.walletClients.get(walletId);
  if (!wc) throw new Error('钱包未初始化');
  await refreshTipConfig();

  const normalizedAmount = normalizeAmount(amountStr, getTradeAmountDecimals(state.currentChain, 'sell', state.tokenInfo.decimals));
  let amt = parseUnits(normalizedAmount, state.tokenInfo.decimals);
  if (_isFourInternal() && state.tokenInfo.decimals >= 9) {
    const GW = 10n ** 9n;
    amt = (amt / GW) * GW;
  }
  if (amt <= 0n) throw new Error('数量太小');
  const tipRate = getTipRate();
  const slippage = parseFloat($('slippage')?.value) || 15;
  const slipBps = BigInt(Math.floor((100 - slippage) * 100));

  let amountOutMin;
  try {
    amountOutMin = await _getQuoteSell(tokenAddr, amt, slipBps);
  } catch (e) {
    throw new Error('无法预估卖出数量: ' + e.message);
  }

  const balance = await state.publicClient.readContract({
    address: tokenAddr, abi: ERC20_ABI, functionName: 'balanceOf', args: [wc.address]
  });
  if (balance < amt) throw new Error('代币余额不足');

  const approveTarget = getSellApproveTarget();
  await ensureApproved(walletId, wc.address, tokenAddr, approveTarget, gasPrice, amt, 'SELL');

  const t0 = performance.now();
  const deadline = BigInt(Math.floor(Date.now() / 1000) + 10);
  console.log('[SELL] token:', tokenAddr, 'amount:', normalizedAmount, 'tipRate:', tipRate.toString());

  const sellQ = _sellQuoteAddr();
  const res = await bscWriteContract(walletId, {
    address: FREEDOM_ROUTER, abi: ROUTER_ABI, functionName: 'trade',
    args: [tokenAddr, sellQ, amt, amountOutMin, tipRate, deadline],
    gas: 800000n, gasPrice: parseUnits(gasPrice.toString(), 9)
  });
  const txHash = res.txHash;

  const tSent = performance.now();
  console.log(`[SELL] txHash: ${txHash} | 发送耗时: ${((tSent - t0) / 1000).toFixed(2)}s`);

  const receipt = await state.publicClient.waitForTransactionReceipt({ hash: txHash, timeout: 120000 });
  const tConfirm = performance.now();

  if (receipt.status !== 'success') throw new Error('交易失败: ' + txHash);
  console.log(`[SELL] ✓ 确认 | 等待: ${((tConfirm - tSent) / 1000).toFixed(2)}s | 总计: ${((tConfirm - t0) / 1000).toFixed(2)}s`);

  return { txHash, sendMs: tSent - t0, confirmMs: tConfirm - tSent, totalMs: tConfirm - t0 };
}
