import { createPublicClient, http, fallback, formatUnits } from 'viem';
import { bsc } from 'viem/chains';
import { initWallets } from './crypto.js';
import { DEFAULT_RPC, BSC_RPCS, ETH_SENTINEL, ERC20_ABI } from './constants.js';
import { state } from './state.js';
import { $, escapeHtml } from './utils.js';

export function createClient(rpcUrl) {
  const url = (rpcUrl || '').trim() || DEFAULT_RPC;
  state.publicClient = createPublicClient({ chain: bsc, transport: http(url) });
}

export function createV4Client(rpcUrl) {
  const custom = (rpcUrl || '').trim();
  const urls = custom ? [custom, ...BSC_RPCS] : BSC_RPCS;
  state.v4PublicClient = createPublicClient({
    chain: bsc,
    transport: fallback(urls.map(u => http(u))),
  });
}

// Background holds WalletClients; frontend only keeps { address } per wallet
export async function initWalletClients() {
  state.walletClients.clear();
  const rpcUrl = (state.config.rpcUrl || '').trim() || DEFAULT_RPC;
  const result = await initWallets(rpcUrl);
  if (result.error) { console.error('initWallets failed:', result.error); return; }

  for (const [id, addr] of Object.entries(result.bsc || {})) {
    state.walletClients.set(id, { address: addr });
  }
  // SOL addresses are handled by wallet-sol.js via the same initWallets call;
  // store them on a shared cache so wallet-sol doesn't need a second call
  state._initWalletsResult = result;
}

export async function loadBscBalances(isCurrent = () => true) {
  try {
    let totalBNB = 0n;
    const balances = [];
    state.walletBalances.clear();
    const activeEntries = state.activeWalletIds.map(id => ({ id, wc: state.walletClients.get(id) })).filter(e => e.wc);
    const bals = await Promise.all(activeEntries.map(e => state.publicClient.getBalance({ address: e.wc.address }).catch(() => 0n)));
    if (!isCurrent()) return false;
    activeEntries.forEach((e, i) => {
      state.walletBalances.set(e.id, bals[i]);
      totalBNB += bals[i];
      balances.push({ id: e.id, name: state.wallets.find(w => w.id === e.id)?.name || e.id, balance: bals[i] });
    });
    $('bnbBalance').textContent = parseFloat(formatUnits(totalBNB, 18)).toFixed(4);
    $('walletCount').textContent = `${state.activeWalletIds.length}/${state.wallets.length}`;

    // Load ERC20 quote token balances if not BNB
    const isNativeQ = state.quoteToken.address === ETH_SENTINEL;
    state.quoteBalances.clear();
    if (!isNativeQ && activeEntries.length > 0) {
      const qBals = await Promise.all(activeEntries.map(e =>
        state.publicClient.readContract({
          address: state.quoteToken.address, abi: ERC20_ABI,
          functionName: 'balanceOf', args: [e.wc.address]
        }).catch(() => 0n)
      ));
      if (!isCurrent()) return false;
      activeEntries.forEach((e, i) => state.quoteBalances.set(e.id, qBals[i]));
    }

    const qs = state.quoteToken.symbol;
    const qDec = state.quoteToken.decimals;
    if (balances.length > 0) {
      $('balanceDetails').innerHTML = balances.map(b => {
        let row = `<div class="bal-row"><span>${escapeHtml(b.name)}</span><span>${parseFloat(formatUnits(b.balance, 18)).toFixed(4)} BNB</span></div>`;
        if (!isNativeQ) {
          const qBal = state.quoteBalances.get(b.id) ?? 0n;
          row += `<div class="bal-row"><span></span><span style="color:var(--accent);">${parseFloat(formatUnits(qBal, qDec)).toFixed(2)} ${qs}</span></div>`;
        }
        return row;
      }).join('');
    } else {
      $('balanceDetails').innerHTML = '';
    }
    return true;
  } catch (e) { console.error(e); }
  return false;
}

export function renderBscWalletSelector(container, onRefresh, onLoadBalances) {
  container.innerHTML = state.wallets.map(w => {
    const isActive = state.activeWalletIds.includes(w.id);
    const hasClient = state.walletClients.has(w.id);
    return `<label class="wallet-chip ${isActive ? 'active' : ''} ${!hasClient ? 'error' : ''}" data-id="${w.id}">
      <input type="checkbox" class="wallet-check" data-id="${w.id}" ${isActive ? 'checked' : ''} ${!hasClient ? 'disabled' : ''}>
      <span>${escapeHtml(w.name)}</span></label>`;
  }).join('');

  container.querySelectorAll('.wallet-check').forEach(cb => {
    cb.onchange = () => {
      const id = cb.dataset.id;
      if (cb.checked) { if (!state.activeWalletIds.includes(id)) state.activeWalletIds.push(id); }
      else { state.activeWalletIds = state.activeWalletIds.filter(aid => aid !== id); }
      chrome.storage.local.set({ activeWalletIds: state.activeWalletIds });
      onRefresh();
      onLoadBalances();
    };
  });
}
