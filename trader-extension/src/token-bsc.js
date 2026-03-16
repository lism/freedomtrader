import { formatUnits, parseUnits } from 'viem';
import { FREEDOM_ROUTER, ROUTER_ABI, ERC20_ABI, ROUTE, ETH_SENTINEL } from './constants.js';
import { state } from './state.js';
import { $, isValidAddress, formatNum, escapeHtml } from './utils.js';
import { showStatus } from './ui.js';
import { updateBalanceHint } from './wallet.js';
import { updatePrice } from './ui.js';

export async function detectBscToken(addr) {
  if (!addr || !isValidAddress(addr)) {
    clearBscTokenDisplay();
    return;
  }

  showStatus('检测中...', 'pending');

  try {
    const tokenEntries = state.activeWalletIds.map(id => ({ id, wc: state.walletClients.get(id) })).filter(e => e.wc);

    const [info, symbol, decimals, ...tokenBals] = await Promise.all([
      state.publicClient.readContract({ address: FREEDOM_ROUTER, abi: ROUTER_ABI, functionName: 'getTokenInfo', args: [addr] }),
      state.publicClient.readContract({ address: addr, abi: ERC20_ABI, functionName: 'symbol' }).catch(() => '???'),
      state.publicClient.readContract({ address: addr, abi: ERC20_ABI, functionName: 'decimals' }).catch(() => 18),
      ...tokenEntries.map(e =>
        state.publicClient.readContract({ address: addr, abi: ERC20_ABI, functionName: 'balanceOf', args: [e.wc.address] }).catch(() => 0n)
      )
    ]);

    let totalBalance = 0n;
    state.tokenBalances.clear();
    tokenEntries.forEach((e, i) => {
      state.tokenBalances.set(e.id, tokenBals[i]);
      totalBalance += tokenBals[i];
    });

    state.tokenInfo = { decimals, symbol: symbol || '???', balance: totalBalance, address: addr };
    $('tokenBalanceDisplay').textContent = parseFloat(formatUnits(totalBalance, decimals)).toFixed(4);

    const route = Number(info.routeSource);
    const isFour = route >= ROUTE.FOUR_INTERNAL_BNB && route <= ROUTE.FOUR_EXTERNAL;
    const isFlap = route === ROUTE.FLAP_BONDING || route === ROUTE.FLAP_BONDING_SELL || route === ROUTE.FLAP_DEX;
    const hasPool = route !== ROUTE.NONE;

    state.lpInfo = {
      hasLP: hasPool,
      routeSource: route,
      approveTarget: info.approveTarget,
      isInternal: info.isInternal,
      tmFunds: info.tmFunds,
      tmMaxFunds: info.tmMaxFunds,
      tmOffers: info.tmOffers,
      flapStatus: info.flapStatus,
    };

    const badge = $('tokenNameBadge');
    const symbolTag = $('tokenSymbolTag');
    const poolTag = $('tokenPoolTag');
    if (badge && symbolTag) {
      symbolTag.textContent = state.tokenInfo.symbol;
      if (poolTag) {
        if (hasPool) {
          if (isFour && info.isInternal) {
            poolTag.textContent = '🔥 Four 内盘';
            poolTag.className = 'tag tag-internal';
          } else if (isFour) {
            poolTag.textContent = '🥞 Four 外盘';
            poolTag.className = 'tag tag-external';
          } else if (route === ROUTE.FLAP_BONDING) {
            poolTag.textContent = '🦋 Flap 内盘';
            poolTag.className = 'tag tag-internal';
          } else if (route === ROUTE.FLAP_BONDING_SELL) {
            poolTag.textContent = '🦋 Flap 内盘(仅卖)';
            poolTag.className = 'tag tag-internal';
          } else if (route === ROUTE.FLAP_DEX) {
            poolTag.textContent = '🦋 Flap DEX';
            poolTag.className = 'tag tag-external';
          } else {
            poolTag.textContent = '🥞 外盘';
            poolTag.className = 'tag tag-external';
          }
        } else {
          poolTag.textContent = '⚠️ 无LP';
          poolTag.className = 'tag tag-internal';
        }
      }
      badge.classList.add('show');
    }

    if (hasPool) {
      showBscLPInfo(info, route);
      const statusText = _routeLabel(route);
      showStatus(statusText, 'success');
    } else {
      showStatus('未找到LP', 'error');
    }

    updateBalanceHint();
    updatePrice();
    if (hasPool) fetchTokenPrice(addr, decimals);
  } catch (e) {
    console.error(e);
    showStatus('检测失败', 'error');
  }
}

async function fetchTokenPrice(tokenAddr, decimals) {
  try {
    const oneToken = 10n ** BigInt(decimals);
    const qAddr = state.quoteToken.address;
    const qDec = state.quoteToken.decimals;
    const qs = state.quoteToken.symbol;
    const priceWei = await state.publicClient.readContract({
      address: FREEDOM_ROUTER, abi: ROUTER_ABI,
      functionName: 'quote', args: [tokenAddr, oneToken, qAddr]
    });
    const price = parseFloat(formatUnits(priceWei, qDec));
    const tag = $('tokenPriceTag');
    if (tag) {
      tag.textContent = `${price.toPrecision(4)} ${qs}`;
      tag.style.display = '';
    }
  } catch (e) {
    console.warn('[PRICE] token price failed:', e.message);
  }
}

function _routeLabel(route) {
  switch (route) {
    case ROUTE.FOUR_INTERNAL_BNB: return 'Four.meme 内盘 (BNB)';
    case ROUTE.FOUR_INTERNAL_ERC20: return 'Four.meme 内盘 (ERC20)';
    case ROUTE.FOUR_EXTERNAL: return 'Four.meme 外盘';
    case ROUTE.FLAP_BONDING: return 'Flap 内盘';
    case ROUTE.FLAP_BONDING_SELL: return 'Flap 内盘 (仅卖出)';
    case ROUTE.FLAP_DEX: return 'Flap DEX';
    case ROUTE.PANCAKE_ONLY: return 'PancakeSwap';
    default: return '未知';
  }
}

function showBscLPInfo(info, route) {
  const div = $('lpInfo');
  if (!div) return;

  const isFlap = route === ROUTE.FLAP_BONDING || route === ROUTE.FLAP_BONDING_SELL || route === ROUTE.FLAP_DEX;
  const isFlapBonding = route === ROUTE.FLAP_BONDING || route === ROUTE.FLAP_BONDING_SELL;
  const poolType = isFlap
    ? (isFlapBonding ? '🦋 Flap 内盘' : '🦋 Flap DEX')
    : (info.isInternal ? '🔥 Four 内盘' : '🥞 PCS 外盘');
  const poolColor = info.isInternal || isFlapBonding ? 'var(--red)' : 'var(--accent)';

  let reserveHtml = '';
  if (info.isInternal) {
    reserveHtml = `
      <div class="lp-res-item">
        <div class="lbl" style="text-transform:uppercase;">BNB 储备</div>
        <div class="val" style="color:var(--yellow);">${formatNum(info.tmFunds, 18)}</div>
      </div>
      <div class="lp-res-item">
        <div class="lbl" title="${escapeHtml(state.tokenInfo.symbol)}" style="color:#00ffaa;font-weight:700;">${escapeHtml(state.tokenInfo.symbol)} 储备</div>
        <div class="val" style="color:var(--accent);">${formatNum(info.tmOffers, state.tokenInfo.decimals)}</div>
      </div>`;
  }

  div.style.display = 'block';
  div.innerHTML = `
    <div class="lp-header">
      <span class="type" style="color:var(--text2);">${poolType}</span>
      <span class="status" style="color:${poolColor};">✓ 已检测</span>
    </div>
    <div class="lp-reserves">${reserveHtml}</div>
  `;
}

export function clearBscTokenDisplay() {
  state.tokenInfo = { decimals: 18, symbol: '', balance: 0n };
  state.lpInfo = { hasLP: false, isInternal: false, routeSource: ROUTE.NONE };
  $('tokenBalanceDisplay').textContent = '-';
  const badge = $('tokenNameBadge'); if (badge) badge.classList.remove('show');
  const priceTag = $('tokenPriceTag'); if (priceTag) priceTag.style.display = 'none';
  const lpDiv = $('lpInfo'); if (lpDiv) lpDiv.style.display = 'none';
  const priceDiv = $('priceInfo'); if (priceDiv) priceDiv.style.display = 'none';
}
