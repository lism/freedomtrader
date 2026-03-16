// Freedom Trader 本地系统 - 配置管理
// 替代 chrome.storage.local，使用本地 JSON 文件

import { readFileSync, writeFileSync, existsSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const CONFIG_FILE = join(__dirname, '..', 'config.json');
const WALLETS_FILE = join(__dirname, '..', 'wallets.enc.json');
const APPROVE_CACHE_FILE = join(__dirname, '..', '.approve-cache.json');

// 默认配置
const DEFAULT_CONFIG = {
  rpcUrl: 'https://bsc-dataseed.bnbchain.org',
  solRpcUrl: 'https://solana-rpc.publicnode.com',
  solWssUrl: '',
  tipRate: 0,
  slippage: 15,
  gasPrice: 3,
  solPriorityFee: 0.0001,
  solJitoTip: 0.0001,
  activeWalletIds: [],
  solActiveWalletIds: [],
};

export function loadConfig() {
  try {
    if (existsSync(CONFIG_FILE)) {
      const data = JSON.parse(readFileSync(CONFIG_FILE, 'utf-8'));
      return { ...DEFAULT_CONFIG, ...data };
    }
  } catch (e) {
    console.error('[CONFIG] 读取配置失败:', e.message);
  }
  return { ...DEFAULT_CONFIG };
}

export function saveConfig(config) {
  try {
    writeFileSync(CONFIG_FILE, JSON.stringify(config, null, 2), 'utf-8');
  } catch (e) {
    console.error('[CONFIG] 保存配置失败:', e.message);
  }
}

export function getConfig(key) {
  const config = loadConfig();
  return config[key];
}

export function setConfig(key, value) {
  const config = loadConfig();
  config[key] = value;
  saveConfig(config);
}

// 钱包存储
export function loadWallets() {
  try {
    if (existsSync(WALLETS_FILE)) {
      const data = JSON.parse(readFileSync(WALLETS_FILE, 'utf-8'));
      return {
        wallets: data.wallets || [],
        solWallets: data.solWallets || [],
        salt: data.salt || null,
        pwHash: data.pwHash || null,
      };
    }
  } catch (e) {
    console.error('[CONFIG] 读取钱包文件失败:', e.message);
  }
  return { wallets: [], solWallets: [], salt: null, pwHash: null };
}

export function saveWallets(data) {
  try {
    writeFileSync(WALLETS_FILE, JSON.stringify(data, null, 2), 'utf-8');
  } catch (e) {
    console.error('[CONFIG] 保存钱包文件失败:', e.message);
  }
}

// 授权缓存
export function loadApproveCache() {
  try {
    if (existsSync(APPROVE_CACHE_FILE)) {
      return JSON.parse(readFileSync(APPROVE_CACHE_FILE, 'utf-8'));
    }
  } catch (e) { /* ignore */ }
  return [];
}

export function saveApproveCache(cache) {
  try {
    writeFileSync(APPROVE_CACHE_FILE, JSON.stringify(cache), 'utf-8');
  } catch (e) { /* ignore */ }
}
