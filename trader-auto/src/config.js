import 'dotenv/config';
import path from 'node:path';

function requireEnv(name) {
  const value = process.env[name];
  if (!value) throw new Error(`缺少环境变量: ${name}`);
  return value;
}

function parseNumber(name, fallback) {
  const raw = process.env[name];
  if (raw == null || raw === '') return fallback;
  const value = Number(raw);
  if (!Number.isFinite(value)) throw new Error(`环境变量 ${name} 不是有效数字`);
  return value;
}

function parseBoolean(name, fallback) {
  const raw = process.env[name];
  if (raw == null || raw === '') return fallback;
  return ['1', 'true', 'yes', 'on'].includes(raw.toLowerCase());
}

function parseList(name) {
  const raw = process.env[name];
  if (!raw) return [];
  return raw.split(',').map((item) => item.trim().toLowerCase()).filter(Boolean);
}

export function loadConfig() {
  const stateFile = process.env.STATE_FILE || './data/runtime.json';

  return {
    privateKey: requireEnv('PRIVATE_KEY'),
    rpcUrl: process.env.RPC_URL || 'https://bsc-dataseed.bnbchain.org',
    fourMeme: {
      tokenManager: process.env.FOUR_MEME_TOKEN_MANAGER || '0x5c952063c7fc8610FFDB798152D69F0B9550762b',
      startBlock: process.env.START_BLOCK ? BigInt(process.env.START_BLOCK) : null,
    },
    pancake: {
      enabled: parseBoolean('ENABLE_PANCAKE_PAIR_SOURCE', true),
      factory: process.env.PANCAKE_FACTORY || '0xcA143Ce32Fe78f1f7019d7d551a6402fC5350c73',
      startBlock: process.env.PANCAKE_START_BLOCK ? BigInt(process.env.PANCAKE_START_BLOCK) : null,
    },
    scanIntervalMs: parseNumber('SCAN_INTERVAL_MS', 3000),
    monitorIntervalMs: parseNumber('MONITOR_INTERVAL_MS', 5000),
    logBlockChunk: parseNumber('LOG_BLOCK_CHUNK', 1),
    buyAmountBnb: parseNumber('BUY_AMOUNT_BNB', 0.01),
    slippagePercent: parseNumber('SLIPPAGE_PERCENT', 10),
    gasPriceGwei: parseNumber('GAS_PRICE_GWEI', 0.05),
    tipRate: parseNumber('TIP_RATE', 0),
    takeProfitPercent: parseNumber('TAKE_PROFIT_PERCENT', 50),
    stopLossPercent: parseNumber('STOP_LOSS_PERCENT', 10),
    autoSellPercent: parseNumber('AUTO_SELL_PERCENT', 100),
    maxOpenPositions: parseNumber('MAX_OPEN_POSITIONS', 3),
    maxTaxPercent: parseNumber('MAX_TAX_PERCENT', 5),
    minProgressPercent: parseNumber('MIN_PROGRESS_PERCENT', 0),
    minLiquidityBnb: parseNumber('MIN_LIQUIDITY_BNB', 5.0),
    minFirstSwapBnb: parseNumber('MIN_FIRST_SWAP_BNB', 0.1),
    minHolders: parseNumber('MIN_HOLDERS', 50),
    maxTop10Holdings: parseNumber('MAX_TOP10_HOLDINGS', 50),
    dryRun: parseBoolean('DRY_RUN', true),
    simulateMode: parseBoolean('SIMULATE_MODE', true),
    testMode: parseBoolean('TEST_MODE', false),
    stateFile: path.resolve(process.cwd(), stateFile),
    tokenAllowlist: parseList('TOKEN_ALLOWLIST'),
    tokenBlocklist: parseList('TOKEN_BLOCKLIST'),
    creatorBlocklist: parseList('CREATOR_BLOCKLIST'),
    creatorWhitelist: parseList('CREATOR_WHITELIST'),
  };
}
