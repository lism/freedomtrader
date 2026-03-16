// Freedom Trader 本地系统 - BSC 代币检测
// 从 Chrome 扩展 token-bsc.js 移植，去掉 DOM 操作

import { formatUnits } from 'viem';
import { FREEDOM_ROUTER, ROUTER_ABI, ERC20_ABI, WBNB, ROUTE } from './constants.js';
import { state } from './state.js';
import { isValidAddress, formatNum } from './utils.js';

export async function detectBscToken(addr) {
  if (!addr || !isValidAddress(addr)) {
    state.tokenInfo = { decimals: 18, symbol: '', balance: 0n };
    state.lpInfo = { hasLP: false, isInternal: false, routeSource: ROUTE.NONE };
    return null;
  }

  console.log('[BSC-DETECT] 检测代币:', addr);

  try {
    const firstWallet = state.walletClients.get(state.activeWalletIds[0]);
    const userAddr = firstWallet?.account?.address || '0x0000000000000000000000000000000000000000';

    const info = await state.publicClient.readContract({
      address: FREEDOM_ROUTER, abi: ROUTER_ABI, functionName: 'getTokenInfo',
      args: [addr, userAddr]
    });

    let totalBalance = 0n;
    state.tokenBalances.clear();
    const tokenEntries = state.activeWalletIds.map(id => ({ id, wc: state.walletClients.get(id) })).filter(e => e.wc);
    const tokenBals = await Promise.all(tokenEntries.map(e =>
      state.publicClient.readContract({ address: addr, abi: ERC20_ABI, functionName: 'balanceOf', args: [e.wc.account.address] }).catch(() => 0n)
    ));
    tokenEntries.forEach((e, i) => {
      state.tokenBalances.set(e.id, tokenBals[i]);
      totalBalance += tokenBals[i];
    });

    state.tokenInfo = { decimals: info.decimals, symbol: info.symbol || '???', balance: totalBalance, address: addr };

    const route = Number(info.routeSource);
    const isFour = route >= ROUTE.FOUR_INTERNAL_BNB && route <= ROUTE.FOUR_EXTERNAL;
    const isFlap = route === ROUTE.FLAP_BONDING || route === ROUTE.FLAP_BONDING_SELL || route === ROUTE.FLAP_DEX;
    const hasPool = route !== ROUTE.NONE;

    let rBNB, rToken;
    if (info.isInternal) {
      rBNB = info.tmFunds;
      rToken = info.tmOffers;
    } else if (isFlap) {
      rBNB = info.flapReserve;
      rToken = info.flapCirculatingSupply;
    } else {
      const tokenLower = addr.toLowerCase() < WBNB.toLowerCase();
      rBNB = tokenLower ? info.pairReserve1 : info.pairReserve0;
      rToken = tokenLower ? info.pairReserve0 : info.pairReserve1;
    }

    state.lpInfo = {
      hasLP: hasPool,
      routeSource: route,
      approveTarget: info.approveTarget,
      isInternal: info.isInternal,
      tmQuote: info.tmQuote,
      reserveBNB: rBNB,
      reserveToken: rToken,
      tmFunds: info.tmFunds,
      tmMaxFunds: info.tmMaxFunds,
      tmOffers: info.tmOffers,
      tmTradingFeeRate: info.tmTradingFeeRate,
      pair: info.pair,
      isTaxToken: info.isTaxToken,
      taxFeeRate: info.taxFeeRate,
      flapStatus: info.flapStatus,
      flapReserve: info.flapReserve,
      flapCirculatingSupply: info.flapCirculatingSupply,
      flapPrice: info.flapPrice,
      flapTaxRate: info.flapTaxRate,
      flapProgress: info.flapProgress,
      flapPool: info.flapPool,
    };

    // 打印检测结果
    const routeLabel = _routeLabel(route);
    console.log(`[BSC-DETECT] ✓ ${info.symbol} | ${routeLabel}`);
    console.log(`  代币余额: ${parseFloat(formatUnits(totalBalance, info.decimals)).toFixed(4)}`);

    if (hasPool) {
      const quoteLabel = isFlap ? '储备' : 'BNB 储备';
      console.log(`  ${quoteLabel}: ${formatNum(rBNB, 18)}`);
      console.log(`  ${info.symbol} 储备: ${formatNum(rToken, info.decimals)}`);

      if (isFlap && info.flapProgress) {
        const pct = (Number(info.flapProgress) / 1e16).toFixed(1);
        console.log(`  进度: ${pct}%`);
      }
      if (isFlap && info.flapTaxRate > 0n) {
        const taxPct = (Number(info.flapTaxRate) / 100).toFixed(1);
        console.log(`  税率: ${taxPct}%`);
      }
    } else {
      console.log('  ⚠️ 未找到LP');
    }

    return { hasPool, route, routeLabel, symbol: info.symbol, decimals: info.decimals };
  } catch (e) {
    console.error('[BSC-DETECT] 检测失败:', e.message);
    return null;
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
