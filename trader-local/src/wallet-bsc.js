// Freedom Trader 本地系统 - BSC 钱包管理
// 替代 Chrome 扩展的 wallet-bsc.js + background.js 中的 BSC 钱包部分

import { createPublicClient, createWalletClient, http, formatUnits } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { bsc } from 'viem/chains';
import { state } from './state.js';
import { loadConfig, loadWallets, saveWallets } from './config.js';
import { decrypt, encrypt, isUnlocked } from './crypto.js';
import { DEFAULT_RPC } from './constants.js';
import { shortAddr } from './utils.js';

// 创建 public client
export function createClient(rpcUrl) {
  const url = (rpcUrl || '').trim() || DEFAULT_RPC;
  state.publicClient = createPublicClient({ chain: bsc, transport: http(url) });
}

// 初始化所有 BSC 钱包客户端
export async function initWalletClients() {
  if (!isUnlocked()) throw new Error('未解锁，请先输入密码');

  state.walletClients.clear();
  const config = loadConfig();
  const rpcUrl = (config.rpcUrl || '').trim() || DEFAULT_RPC;
  createClient(rpcUrl);

  const walletsData = loadWallets();
  state.wallets = walletsData.wallets || [];
  state.activeWalletIds = config.activeWalletIds || [];

  for (const w of state.wallets) {
    try {
      const plain = decrypt(w.encryptedKey);
      if (!plain) continue;
      let key = plain.startsWith('0x') ? plain : '0x' + plain;
      const account = privateKeyToAccount(key);
      const client = createWalletClient({ chain: bsc, transport: http(rpcUrl), account });
      state.walletClients.set(w.id, { client, account });
    } catch (e) {
      console.error(`[BSC] 钱包 ${w.name} 初始化失败:`, e.message);
    }
  }

  // 如果没有激活的钱包，默认激活所有
  if (state.activeWalletIds.length === 0 && state.wallets.length > 0) {
    state.activeWalletIds = state.wallets.map(w => w.id);
  }

  console.log(`[BSC] 初始化完成: ${state.walletClients.size}/${state.wallets.length} 个钱包`);
}

// 添加 BSC 钱包
export function addBscWallet(name, privateKey) {
  const encryptedKey = encrypt(privateKey);
  let key = privateKey.startsWith('0x') ? privateKey : '0x' + privateKey;
  const account = privateKeyToAccount(key);
  const id = `bsc_${Date.now()}`;

  const data = loadWallets();
  data.wallets = data.wallets || [];
  data.wallets.push({ id, name, encryptedKey });
  saveWallets(data);

  console.log(`[BSC] 钱包已添加: ${name} (${shortAddr(account.address)})`);
  return { id, name, address: account.address };
}

// 加载 BSC 余额
export async function loadBscBalances() {
  try {
    let totalBNB = 0n;
    const balances = [];
    state.walletBalances.clear();

    const activeEntries = state.activeWalletIds
      .map(id => ({ id, wc: state.walletClients.get(id) }))
      .filter(e => e.wc);

    const bals = await Promise.all(
      activeEntries.map(e => state.publicClient.getBalance({ address: e.wc.account.address }).catch(() => 0n))
    );

    activeEntries.forEach((e, i) => {
      state.walletBalances.set(e.id, bals[i]);
      totalBNB += bals[i];
      balances.push({
        name: state.wallets.find(w => w.id === e.id)?.name || e.id,
        balance: bals[i],
        address: e.wc.account.address,
      });
    });

    return { totalBNB, balances };
  } catch (e) {
    console.error('[BSC] 加载余额失败:', e.message);
    return { totalBNB: 0n, balances: [] };
  }
}

// BSC 合约写入（直接调用，不需要 background message passing）
export async function bscWriteContract(walletId, { address, abi, functionName, args, value, gas, gasPrice }) {
  const wc = state.walletClients.get(walletId);
  if (!wc) throw new Error('钱包未初始化: ' + walletId);

  const params = { address, abi, functionName, args, gas, gasPrice };
  if (value != null) params.value = value;

  const txHash = await wc.client.writeContract(params);
  return { txHash };
}

// 列出钱包
export function listBscWallets() {
  const wallets = [];
  for (const w of state.wallets) {
    const wc = state.walletClients.get(w.id);
    const isActive = state.activeWalletIds.includes(w.id);
    wallets.push({
      id: w.id,
      name: w.name,
      address: wc?.account?.address || '(未初始化)',
      active: isActive,
      balance: state.walletBalances.get(w.id) || 0n,
    });
  }
  return wallets;
}
