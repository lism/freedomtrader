import { formatUnits, parseUnits } from 'viem';
import { state } from './state.js';
import { $, formatNum, getTradeAmountDecimals, normalizeAmount, sanitizeAmountInput, withTimeout } from './utils.js';
import { FREEDOM_ROUTER, ROUTER_ABI, ROUTE, ETH_SENTINEL, QUOTE_TOKENS } from './constants.js';
import { LAMPORTS_PER_SOL } from './sol/constants.js';

function isSol() { return state.currentChain === 'sol'; }
function nativeSymbol() { return isSol() ? 'SOL' : 'BNB'; }
function quoteSymbol() { return isSol() ? 'SOL' : state.quoteToken.symbol; }
function _isNativeQuote() { return state.quoteToken.address === ETH_SENTINEL; }
function getAmountInputDecimals(mode = state.tradeMode) {
  return mode === 'sell'
    ? getTradeAmountDecimals(state.currentChain, 'sell', state.tokenInfo.decimals)
    : null;
}
function getTradeDecimals(mode = state.tradeMode) {
  return getTradeAmountDecimals(state.currentChain, mode, state.tokenInfo.decimals);
}
function getAmountDraftBucket() {
  return state.amountDrafts[state.currentChain];
}
function getStoredBuyAmount() {
  return isSol() ? (state.config.solBuyAmount || '') : (state.config.buyAmount || '');
}
function setStoredBuyAmount(value) {
  const key = isSol() ? 'solBuyAmount' : 'buyAmount';
  if (isSol()) state.config.solBuyAmount = value;
  else state.config.buyAmount = value;
  chrome.storage.local.set({ [key]: value });
}
function getAmountDraft(mode = state.tradeMode) {
  const drafts = getAmountDraftBucket();
  if (mode === 'buy' && drafts.buy === '') {
    drafts.buy = sanitizeAmountInput(getStoredBuyAmount(), null);
  }
  return drafts[mode] || '';
}
function cacheAmountDraft(value, mode = state.tradeMode, persist = mode === 'buy') {
  const sanitized = sanitizeAmountInput(value, getAmountInputDecimals(mode));
  getAmountDraftBucket()[mode] = sanitized;
  if (persist && mode === 'buy') setStoredBuyAmount(sanitized);
  return sanitized;
}
function applyAmountValue(value, mode = state.tradeMode, persist = mode === 'buy') {
  const sanitized = cacheAmountDraft(value, mode, persist);
  const amountEl = $('amount');
  if (amountEl && amountEl.value !== sanitized) amountEl.value = sanitized;
  return sanitized;
}
function restoreAmountDraft(mode = state.tradeMode) {
  return applyAmountValue(getAmountDraft(mode), mode, false);
}

export function showStatus(msg, type) {
  $('statusBar').textContent = msg;
  $('statusBar').className = 'status-bar ' + type;
  $('statusBar').style.display = 'block';
}

export function showToast(msg, type = 'success', duration = 3000) {
  const toast = $('toast'); if (!toast) return;
  toast.textContent = msg; toast.className = 'toast ' + type; toast.classList.add('show');
  setTimeout(() => toast.classList.remove('show'), duration);
}

export function updateSlippageBtn(val) {
  document.querySelectorAll('.slip-btn').forEach(btn => btn.classList.toggle('active', btn.dataset.slip === val));
  $('warningBox').classList.toggle('show', parseFloat(val) >= 25);
}

let _priceTimer = null;
let _priceRequestId = 0;
export function updatePrice() {
  clearTimeout(_priceTimer);
  const requestId = ++_priceRequestId;
  _priceTimer = setTimeout(() => _updatePriceImpl(requestId), 300);
}

function isPriceRequestCurrent(requestId) {
  return requestId === _priceRequestId;
}

async function _updatePriceImpl(requestId) {
  const div = $('priceInfo');
  const amountEl = $('amount');
  const normalizedAmount = normalizeAmount(amountEl?.value || '', getTradeDecimals());
  const amount = parseFloat(normalizedAmount) || 0;
  if (!div || !state.lpInfo.hasLP || amount <= 0) { if (div && isPriceRequestCurrent(requestId)) div.style.display = 'none'; return; }

  const slip = parseFloat($('slippage').value) || 15;
  const sol = isSol();
  const walletCount = sol
    ? state.solActiveWalletIds.filter(id => state.solAddresses.has(id)).length
    : state.activeWalletIds.filter(id => state.walletClients.has(id)).length;
  if (walletCount === 0) { if (div && isPriceRequestCurrent(requestId)) div.style.display = 'none'; return; }
  const amountPerWallet = normalizeAmount((amount / walletCount).toString(), getTradeDecimals());

  const nativeDec = sol ? 9 : 18;
  const ns = nativeSymbol();

  try {
    if (!sol && state.tokenInfo.address && state.publicClient) {
      await _updateRouterPrice(div, amountPerWallet, walletCount, slip, requestId);
      return;
    }

    // SOL: local AMM calc using virtualReserves
    const quoteReserve = state.lpInfo.reserveBNB;
    const tokenReserve = state.lpInfo.reserveToken;
    if (!quoteReserve || !tokenReserve) { if (isPriceRequestCurrent(requestId)) div.style.display = 'none'; return; }
    if (!isPriceRequestCurrent(requestId)) return;

    if (state.tradeMode === 'buy') {
      const amt = parseUnits(amountPerWallet, nativeDec);
      let est = quoteReserve > 0n ? (amt * tokenReserve) / (quoteReserve + amt) : 0n;
      if (est > tokenReserve) est = tokenReserve;
      const min = (est * BigInt(Math.floor((100 - slip) * 100))) / 10000n;
      $('estimatedPrice').textContent = `≈ ${formatNum(est, state.tokenInfo.decimals)} ${state.tokenInfo.symbol} × ${walletCount}`;
      $('minOutput').textContent = `≥ ${formatNum(min * BigInt(walletCount), state.tokenInfo.decimals)} ${state.tokenInfo.symbol}`;
    } else {
      const amt = parseUnits(amountPerWallet, state.tokenInfo.decimals);
      let est = tokenReserve > 0n ? (amt * quoteReserve) / (tokenReserve + amt) : 0n;
      if (est > quoteReserve) est = quoteReserve;
      const min = (est * BigInt(Math.floor((100 - slip) * 100))) / 10000n;
      $('estimatedPrice').textContent = `≈ ${formatNum(est, nativeDec)} ${ns} × ${walletCount}`;
      $('minOutput').textContent = `≥ ${formatNum(min * BigInt(walletCount), nativeDec)} ${ns}`;
    }
    div.style.display = 'block';
  } catch (e) {
    if (isPriceRequestCurrent(requestId) && div) div.style.display = 'none';
  }
}

async function _updateRouterPrice(div, amountPerWallet, walletCount, slip, requestId) {
  const token = state.tokenInfo.address;
  const dec = state.tokenInfo.decimals;
  const qAddr = state.quoteToken.address;
  const qDec = state.quoteToken.decimals;
  const qs = quoteSymbol();
  try {
    if (state.tradeMode === 'buy') {
      const funds = parseUnits(amountPerWallet, qDec);
      const est = await withTimeout(state.publicClient.readContract({
        address: FREEDOM_ROUTER, abi: ROUTER_ABI, functionName: 'quote', args: [qAddr, funds, token]
      }), 10000);
      if (!isPriceRequestCurrent(requestId)) return;
      const min = (est * BigInt(Math.floor((100 - slip) * 100))) / 10000n;
      $('estimatedPrice').textContent = `≈ ${formatNum(est, dec)} ${state.tokenInfo.symbol} × ${walletCount}`;
      $('minOutput').textContent = `≥ ${formatNum(min * BigInt(walletCount), dec)} ${state.tokenInfo.symbol}`;
    } else {
      // Internal tokens always sell to BNB regardless of quote selection
      const isFourInt = state.lpInfo.routeSource === ROUTE.FOUR_INTERNAL_BNB || state.lpInfo.routeSource === ROUTE.FOUR_INTERNAL_ERC20;
      const sellQ = isFourInt ? ETH_SENTINEL : qAddr;
      const sellDec = isFourInt ? 18 : qDec;
      const sellQs = isFourInt ? 'BNB' : qs;
      const amt = parseUnits(amountPerWallet, dec);
      const est = await withTimeout(state.publicClient.readContract({
        address: FREEDOM_ROUTER, abi: ROUTER_ABI, functionName: 'quote', args: [token, amt, sellQ]
      }), 10000);
      if (!isPriceRequestCurrent(requestId)) return;
      const min = (est * BigInt(Math.floor((100 - slip) * 100))) / 10000n;
      $('estimatedPrice').textContent = `≈ ${formatNum(est > 0n ? est : 0n, sellDec)} ${sellQs} × ${walletCount}`;
      $('minOutput').textContent = `≥ ${formatNum(min > 0n ? min * BigInt(walletCount) : 0n, sellDec)} ${sellQs}`;
    }
    div.style.display = 'block';
  } catch (e) {
    console.warn('[PRICE] quote failed:', e.message);
    if (isPriceRequestCurrent(requestId)) div.style.display = 'none';
  }
}

export function switchMode(mode) {
  const prevMode = state.tradeMode;
  const amountEl = $('amount');
  if (amountEl && prevMode !== mode) cacheAmountDraft(amountEl.value, prevMode);
  state.tradeMode = mode;
  $('tabBuy').classList.toggle('active', mode === 'buy');
  $('tabSell').classList.toggle('active', mode === 'sell');
  $('tradeBtn').className = 'btn-trade ' + (mode === 'buy' ? 'btn-buy' : 'btn-sell');
  $('tradeBtn').textContent = mode === 'buy' ? '🚀 买入' : '💥 卖出';
  const qs = quoteSymbol();
  $('amountLabel').textContent = mode === 'buy' ? `买入数量 (${qs}/钱包)` : '卖出数量 (' + state.tokenInfo.symbol + '/钱包)';
  $('buyQuickRow').style.display = mode === 'buy' ? 'flex' : 'none';
  $('sellPercentRow').classList.toggle('show', mode === 'sell');
  restoreAmountDraft(mode);
  updatePrice();
}

export function setMax() {
  const amountEl = $('amount');
  if (!amountEl) return;
  if (state.tradeMode === 'buy') {
    const sol = isSol();
    const activeIds = sol ? state.solActiveWalletIds : state.activeWalletIds;
    const useQuoteBal = !sol && !_isNativeQuote();
    const balMap = sol ? state.solWalletBalances : (useQuoteBal ? state.quoteBalances : state.walletBalances);
    const dec = sol ? 9 : state.quoteToken.decimals;
    const reserveStr = sol ? '0.01' : (_isNativeQuote() ? '0.005' : '0');
    let minBal = null;
    for (const id of activeIds) { const bal = balMap.get(id); if (bal !== undefined && (minBal === null || bal < minBal)) minBal = bal; }
    if (minBal !== null && minBal > 0n) {
      const reserve = parseUnits(reserveStr, dec);
      applyAmountValue(normalizeAmount(formatUnits(minBal > reserve ? minBal - reserve : 0n, dec), dec), 'buy');
    }
    else applyAmountValue('0', 'buy');
  } else { setPercentAmount(100); }
  updatePrice();
}

export function setPercentAmount(pct) {
  const amountEl = $('amount');
  if (!amountEl || !state.tokenInfo.address) {
    if (amountEl) applyAmountValue('0', 'sell', false);
    updatePrice();
    return;
  }
  const activeIds = isSol() ? state.solActiveWalletIds : state.activeWalletIds;
  let minBal = null;
  for (const id of activeIds) { const bal = state.tokenBalances.get(id); if (bal !== undefined && (minBal === null || bal < minBal)) minBal = bal; }
  const sellDec = getTradeAmountDecimals(state.currentChain, 'sell', state.tokenInfo.decimals);
  if (minBal !== null && minBal > 0n) applyAmountValue(normalizeAmount(formatUnits((minBal * BigInt(pct)) / 100n, state.tokenInfo.decimals), sellDec), 'sell', false);
  else applyAmountValue('0', 'sell', false);
  updatePrice();
}

export function renderAllQuickButtons() {
  const sol = isSol();
  const quickBuy = ((sol ? state.config.solCustomQuickBuy : state.config.customQuickBuy) || (sol ? '0.1,0.25,0.5,1,2' : '0.01,0.05,0.1,0.5,1')).split(',').map(s => s.trim()).filter(Boolean);
  const slipVals = ((sol ? state.config.solCustomSlipValues : state.config.customSlipValues) || '5,10,15,25,49').split(',').map(s => s.trim()).filter(Boolean);
  const fastBuyAmts = ((sol ? state.config.solCustomBuyAmounts : state.config.customBuyAmounts) || (sol ? '0.1,0.25,0.5,1' : '0.01,0.05,0.1,0.5')).split(',').map(s => s.trim()).filter(Boolean);
  const fastSellPcts = ((sol ? state.config.solCustomSellPcts : state.config.customSellPcts) || '25,50,75,100').split(',').map(s => s.trim()).filter(Boolean);

  const buyQuickRow = $('buyQuickRow');
  if (buyQuickRow) {
    buyQuickRow.innerHTML = quickBuy.map(a =>
      `<button type="button" class="quick-btn" data-amt="${a}">${a}</button>`
    ).join('');
  }

  const slipRow = $('slipPresets');
  if (slipRow) {
    slipRow.innerHTML = slipVals.map(v =>
      `<button type="button" class="slip-btn slippage-btn" data-slip="${v}">${v}</button>`
    ).join('');
    updateSlippageBtn($('slippage')?.value || '15');
  }

  const fastBuyRow = $('fastBuyRow');
  if (fastBuyRow) {
    fastBuyRow.innerHTML = fastBuyAmts.map(a =>
      `<button type="button" class="fast-btn fast-buy" data-amt="${a}">买${a}${isSol() ? '' : ''}</button>`
    ).join('');
  }

  const fastSellRow = $('fastSellRow');
  if (fastSellRow) {
    fastSellRow.innerHTML = fastSellPcts.map(p =>
      `<button type="button" class="fast-btn fast-sell" data-pct="${p}">${p === '100' ? '全卖' : '卖' + p + '%'}</button>`
    ).join('');
  }
}

export function toggleQuickEdit(show) {
  const panel = $('quickEditPanel');
  if (!panel) return;
  panel.style.display = show ? 'block' : 'none';
  if (show) {
    const sol = isSol();
    const defaults = sol
      ? { qb: '0.1, 0.25, 0.5, 1, 2', ba: '0.1, 0.25, 0.5, 1' }
      : { qb: '0.01, 0.05, 0.1, 0.5, 1', ba: '0.01, 0.05, 0.1, 0.5' };
    $('customQuickBuy').value = (sol ? state.config.solCustomQuickBuy : state.config.customQuickBuy) || defaults.qb;
    $('customSlipValues').value = (sol ? state.config.solCustomSlipValues : state.config.customSlipValues) || '5, 10, 15, 25, 49';
    $('customBuyAmounts').value = (sol ? state.config.solCustomBuyAmounts : state.config.customBuyAmounts) || defaults.ba;
    $('customSellPcts').value = (sol ? state.config.solCustomSellPcts : state.config.customSellPcts) || '25, 50, 75, 100';
  }
}

export function saveQuickConfig() {
  const quickBuy = $('customQuickBuy').value.trim();
  const slipVals = $('customSlipValues').value.trim();
  const fastBuyVal = $('customBuyAmounts').value.trim();
  const fastSellVal = $('customSellPcts').value.trim();
  const sol = isSol();
  if (sol) {
    if (quickBuy) state.config.solCustomQuickBuy = quickBuy;
    if (slipVals) state.config.solCustomSlipValues = slipVals;
    if (fastBuyVal) state.config.solCustomBuyAmounts = fastBuyVal;
    if (fastSellVal) state.config.solCustomSellPcts = fastSellVal;
    chrome.storage.local.set({ solCustomQuickBuy: quickBuy, solCustomSlipValues: slipVals, solCustomBuyAmounts: fastBuyVal, solCustomSellPcts: fastSellVal });
  } else {
    if (quickBuy) state.config.customQuickBuy = quickBuy;
    if (slipVals) state.config.customSlipValues = slipVals;
    if (fastBuyVal) state.config.customBuyAmounts = fastBuyVal;
    if (fastSellVal) state.config.customSellPcts = fastSellVal;
    chrome.storage.local.set({ customQuickBuy: quickBuy, customSlipValues: slipVals, customBuyAmounts: fastBuyVal, customSellPcts: fastSellVal });
  }
  renderAllQuickButtons();
  toggleQuickEdit(false);
  showToast('快捷按钮已更新', 'success');
}

export function applyChainUI() {
  const sol = isSol();
  const ns = nativeSymbol();

  // Chain buttons
  const bscBtn = $('chainBsc');
  const solBtn = $('chainSol');
  if (bscBtn) bscBtn.classList.toggle('active', !sol);
  if (solBtn) solBtn.classList.toggle('active', sol);

  // Balance label
  const balLabel = document.querySelector('.bal-label');
  if (balLabel) balLabel.textContent = `${ns} 余额`;

  // Gas/Priority Fee label + Jito column visibility
  const gasLabel = $('gasLabel');
  const jitoCol = $('jitoCol');
  if (sol) {
    if (gasLabel) gasLabel.textContent = 'Priority Fee (SOL)';
    if (jitoCol) jitoCol.style.display = '';
  } else {
    if (gasLabel) gasLabel.textContent = 'Gas (Gwei)';
    if (jitoCol) jitoCol.style.display = 'none';
  }

  // Quote token selector: BSC only
  const quoteSelect = $('quoteSelect');
  if (quoteSelect) quoteSelect.style.display = sol ? 'none' : '';

  // Address placeholder
  const tokenInput = $('tokenAddress');
  if (tokenInput) tokenInput.placeholder = sol ? 'base58 地址' : '0x...';

  // Amount label
  switchMode(state.tradeMode);

  // V4 tab: BSC only
  const v4Tab = $('pageTabV4');
  if (v4Tab) {
    v4Tab.style.display = sol ? 'none' : '';
    // If on SOL and V4 tab active, switch back to trade
    if (sol && v4Tab.classList.contains('active')) {
      v4Tab.classList.remove('active');
      $('tabV4')?.classList.remove('active');
      $('pageTabTrade')?.classList.add('active');
      $('tabTrade')?.classList.add('active');
    }
  }
}

export function switchQuoteToken(symbol) {
  const qt = QUOTE_TOKENS.find(t => t.symbol === symbol);
  if (!qt) return;
  state.quoteToken = { ...qt };
  chrome.storage.local.set({ quoteToken: symbol });
  switchMode(state.tradeMode);
  import('./wallet.js').then(m => m.loadBalances());
}

// setupEvents 依赖 batch/token，用延迟 import 避免循环依赖
export function setupEvents() {
  const tokenInput = $('tokenAddress');
  const amountInput = $('amount');
  const slippageInput = $('slippage');

  document.addEventListener('click', async (e) => {
    const clickedId = e.target.id;
    if (clickedId === 'editQuickBtn') { e.preventDefault(); toggleQuickEdit(true); return; }

    const t = e.target.closest && e.target.closest('button');
    if (!t) return;
    if (t.id === 'maxBtn') { e.preventDefault(); setMax(); return; }
    if (t.id === 'tradeBtn') {
      e.preventDefault();
      const { executeBatchTrade } = await import('./batch.js');
      executeBatchTrade();
      return;
    }
    if (t.id === 'tabBuy') { e.preventDefault(); switchMode('buy'); return; }
    if (t.id === 'tabSell') { e.preventDefault(); switchMode('sell'); return; }
    if (t.classList?.contains('slippage-btn') && t.dataset.slip) {
      e.preventDefault(); if (slippageInput) slippageInput.value = t.dataset.slip;
      updateSlippageBtn(t.dataset.slip);
      chrome.storage.local.set({ [isSol() ? 'solSlippage' : 'slippage']: t.dataset.slip });
      updatePrice();
      return;
    }
    if (t.classList?.contains('quick-btn') && t.dataset.amt) {
      e.preventDefault();
      applyAmountValue(t.dataset.amt);
      updatePrice();
      return;
    }
    if (t.classList?.contains('percent-btn') && t.dataset.pct) { e.preventDefault(); setPercentAmount(parseInt(t.dataset.pct, 10)); return; }
    if (t.id === 'settingsBtn' || t.id === 'goSettingsBtn') { e.preventDefault(); location.href = 'settings.html'; return; }
    if (t.classList?.contains('fast-buy') && t.dataset.amt) {
      e.preventDefault();
      const { fastBuy } = await import('./batch.js');
      fastBuy(t.dataset.amt);
      return;
    }
    if (t.classList?.contains('fast-sell') && t.dataset.pct) {
      e.preventDefault();
      const { fastSell } = await import('./batch.js');
      fastSell(parseInt(t.dataset.pct, 10));
      return;
    }
    if (t.id === 'saveQuickBtn') { e.preventDefault(); saveQuickConfig(); return; }
    if (t.id === 'cancelQuickBtn') { e.preventDefault(); toggleQuickEdit(false); return; }
  });

  const quoteSelect = $('quoteSelect');
  if (quoteSelect) quoteSelect.onchange = () => switchQuoteToken(quoteSelect.value);

  if (tokenInput) {
    let timer;
    tokenInput.oninput = () => {
      clearTimeout(timer);
      timer = setTimeout(async () => {
        const addr = tokenInput.value.trim();
        const { detectToken } = await import('./token.js');
        detectToken(addr);
      }, 300);
    };
  }
  if (amountInput) amountInput.oninput = () => {
    applyAmountValue(amountInput.value, state.tradeMode, state.tradeMode === 'buy');
    updatePrice();
  };
  if (slippageInput) slippageInput.oninput = () => {
    updateSlippageBtn(slippageInput.value); updatePrice();
    const key = isSol() ? 'solSlippage' : 'slippage';
    chrome.storage.local.set({ [key]: slippageInput.value });
  };

  const gasInput = $('gasPriceInput');
  if (gasInput) gasInput.oninput = () => {
    if (isSol()) {
      const lamports = Math.round(parseFloat(gasInput.value || '0') * LAMPORTS_PER_SOL);
      state.solConfig.priorityFee = lamports;
      chrome.storage.local.set({ solPriorityFee: lamports });
    } else {
      chrome.storage.local.set({ gasPrice: gasInput.value });
    }
  };

  const jitoInput = $('jitoTipInput');
  if (jitoInput) jitoInput.oninput = () => {
    const lamports = Math.round(parseFloat(jitoInput.value || '0') * LAMPORTS_PER_SOL);
    state.solConfig.jitoTip = lamports;
    chrome.storage.local.set({ solJitoTip: lamports });
  };
}
