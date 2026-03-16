// Freedom Trader 本地系统 - SOL 代币检测
// 从 Chrome 扩展 token-sol.js 移植，去掉 DOM 操作

import { formatUnits } from 'viem';
import { state } from './state.js';
import { isValidSolAddress, formatNum } from './utils.js';
import { LAMPORTS_PER_SOL, FALLBACK_SOL_RPCS } from './sol/constants.js';
import { setConnection, getWssUrl, getConnection } from './sol/connection.js';

function isRpcError(msg) {
  return msg.includes('403') || msg.includes('410') ||
    /fetch failed|ECONNREFUSED|ETIMEDOUT|network|socket|429|too many/i.test(msg);
}

async function detectWithFallback(addr) {
  const { detectToken: solDetect } = await import('./sol/trading.js');
  const { getTokenBalance } = await import('./sol/accounts.js');

  const userConn = getConnection();

  // 先尝试用户配置的 RPC
  try {
    const result = await solDetect(addr);
    return { result, getTokenBalance };
  } catch (e) {
    const msg = String(e?.message || e || '');
    if (!isRpcError(msg)) throw e;
    console.warn('[SOL-DETECT] 用户 RPC 失败:', msg);
  }

  const savedWss = getWssUrl();
  let lastErr;
  for (const rpc of FALLBACK_SOL_RPCS) {
    try {
      setConnection(rpc);
      console.log('[SOL-DETECT] 尝试备用 RPC:', rpc);
      const result = await solDetect(addr);
      if (userConn) setConnection(userConn.rpcEndpoint, savedWss);
      return { result, getTokenBalance };
    } catch (e) {
      lastErr = e;
      const msg = String(e?.message || e || '');
      console.warn(`[SOL-DETECT] RPC ${rpc} 失败:`, msg);
      if (!isRpcError(msg)) throw e;
    }
  }
  if (userConn) setConnection(userConn.rpcEndpoint, savedWss);
  throw lastErr;
}

export async function detectSolToken(addr) {
  if (!addr || !isValidSolAddress(addr)) {
    state.tokenInfo = { decimals: 6, symbol: '', balance: 0n };
    state.lpInfo = { hasLP: false, isInternal: false };
    return null;
  }

  console.log('[SOL-DETECT] 检测代币:', addr);

  try {
    const { result, getTokenBalance } = await detectWithFallback(addr);

    if (!result) {
      state.tokenInfo = { decimals: 6, symbol: '???', balance: 0n, address: addr };
      state.lpInfo = { hasLP: false, isInternal: false };
      console.log('[SOL-DETECT] ⚠️ 非 Pump.fun 代币');
      return null;
    }

    const decimals = 6;

    state.tokenBalances.clear();
    const activeWallets = state.solActiveWalletIds
      .map(id => ({ id, pk: state.solAddresses.get(id) }))
      .filter(e => e.pk);

    const { getTokenMetadata } = await import('./sol/accounts.js');
    const [tokenBals, meta] = await Promise.all([
      Promise.all(activeWallets.map(e =>
        getTokenBalance(e.pk, result.mint, result.tokenProgram).catch(() => 0n)
      )),
      getTokenMetadata(result.mint).catch(() => null),
    ]);
    const symbol = meta?.symbol || 'PUMP';
    const tokenName = meta?.name || '';

    let totalBalance = 0n;
    activeWallets.forEach((e, i) => {
      state.tokenBalances.set(e.id, tokenBals[i]);
      totalBalance += tokenBals[i];
    });

    const isBondingCurve = result.type === 'bonding-curve';
    const hasPool = result.type === 'bonding-curve' || result.type === 'pumpswap';

    let virtualSOL = 0n, virtualToken = 0n;
    let displaySOL = 0n, displayToken = 0n;
    if (isBondingCurve) {
      virtualSOL = result.virtualSolReserves;
      virtualToken = result.virtualTokenReserves;
      displaySOL = result.realSolReserves;
      displayToken = result.realTokenReserves;
    } else if (result.type === 'pumpswap' && result.pool) {
      try {
        const { getPoolReserves } = await import('./sol/accounts.js');
        const reserves = await getPoolReserves(result.pool);
        virtualSOL = reserves.quoteReserve;
        virtualToken = reserves.baseReserve;
        displaySOL = virtualSOL;
        displayToken = virtualToken;
      } catch (e) {
        console.warn('[SOL-DETECT] 读取 pool reserves 失败:', e.message);
      }
    }

    state.tokenInfo = { decimals, symbol, name: tokenName, balance: totalBalance, address: addr };
    state.lpInfo = {
      hasLP: hasPool,
      isInternal: isBondingCurve,
      reserveBNB: virtualSOL,
      reserveToken: virtualToken,
      displaySOL,
      displayToken,
      solDetectResult: result,
    };

    // 打印检测结果
    const poolType = isBondingCurve ? '🔥 Pump 内盘' : '💧 PumpSwap 外盘';
    const statusLabel = isBondingCurve ? 'Pump 内盘 (Bonding Curve)' : 'PumpSwap 外盘 (AMM)';
    const displayName = tokenName ? `${tokenName} (${symbol})` : symbol;

    console.log(`[SOL-DETECT] ✓ ${displayName} | ${hasPool ? statusLabel : '未找到Pool'}`);
    console.log(`  代币余额: ${parseFloat(formatUnits(totalBalance, decimals)).toFixed(4)}`);

    if (hasPool) {
      console.log(`  ${poolType}`);
      console.log(`  SOL 储备: ${(Number(displaySOL) / LAMPORTS_PER_SOL).toFixed(4)}`);
      console.log(`  ${symbol} 储备: ${formatNum(displayToken, decimals)}`);
    } else {
      console.log('  ⚠️ 未找到Pool');
    }

    return { hasPool, isBondingCurve, symbol, decimals, tokenName };
  } catch (e) {
    console.error('[SOL-DETECT] 检测失败:', e.message);
    return null;
  }
}
