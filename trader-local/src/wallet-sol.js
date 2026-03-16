// Freedom Trader 本地系统 - SOL 钱包管理
// 替代 Chrome 扩展的 wallet-sol.js + background.js 中的 SOL 钱包部分

import { Keypair, PublicKey, Connection, Transaction } from '@solana/web3.js';
import bs58 from 'bs58';
import { state } from './state.js';
import { loadConfig, loadWallets, saveWallets } from './config.js';
import { decrypt, encrypt, isUnlocked } from './crypto.js';
import { shortAddr } from './utils.js';

const JITO_BLOCK_ENGINES = [
  'https://mainnet.block-engine.jito.wtf',
  'https://amsterdam.mainnet.block-engine.jito.wtf',
  'https://frankfurt.mainnet.block-engine.jito.wtf',
  'https://ny.mainnet.block-engine.jito.wtf',
  'https://tokyo.mainnet.block-engine.jito.wtf',
  'https://slc.mainnet.block-engine.jito.wtf',
];

// 初始化 SOL 钱包
export async function initSolWallets() {
  if (!isUnlocked()) throw new Error('未解锁，请先输入密码');

  state.solKeypairs.clear();
  state.solAddresses.clear();

  const config = loadConfig();
  const walletsData = loadWallets();
  state.solWallets = walletsData.solWallets || [];
  state.solActiveWalletIds = config.solActiveWalletIds || [];

  for (const w of state.solWallets) {
    try {
      const plain = decrypt(w.encryptedKey);
      if (!plain) continue;
      const keypair = Keypair.fromSecretKey(bs58.decode(plain));
      state.solKeypairs.set(w.id, keypair);
      state.solAddresses.set(w.id, keypair.publicKey);
    } catch (e) {
      console.error(`[SOL] 钱包 ${w.name} 初始化失败:`, e.message);
    }
  }

  // 如果没有激活的钱包，默认激活所有
  if (state.solActiveWalletIds.length === 0 && state.solWallets.length > 0) {
    state.solActiveWalletIds = state.solWallets.map(w => w.id);
  }

  console.log(`[SOL] 初始化完成: ${state.solKeypairs.size}/${state.solWallets.length} 个钱包`);
}

// 添加 SOL 钱包
export function addSolWallet(name, privateKeyBase58) {
  const keypair = Keypair.fromSecretKey(bs58.decode(privateKeyBase58));
  const encryptedKey = encrypt(privateKeyBase58);
  const id = `sol_${Date.now()}`;

  const data = loadWallets();
  data.solWallets = data.solWallets || [];
  data.solWallets.push({ id, name, encryptedKey });
  saveWallets(data);

  console.log(`[SOL] 钱包已添加: ${name} (${shortAddr(keypair.publicKey.toBase58())})`);
  return { id, name, address: keypair.publicKey.toBase58() };
}

// 加载 SOL 余额
export async function loadSolBalances() {
  try {
    const { getConnection } = await import('./sol/connection.js');
    const conn = getConnection();
    let totalSOL = 0n;
    const balances = [];
    state.solWalletBalances.clear();

    const activeEntries = state.solActiveWalletIds
      .map(id => ({ id, pubkey: state.solAddresses.get(id) }))
      .filter(e => e.pubkey);

    const bals = await Promise.all(
      activeEntries.map(e => conn.getBalance(e.pubkey).catch(() => 0))
    );

    activeEntries.forEach((e, i) => {
      const lamports = BigInt(bals[i]);
      state.solWalletBalances.set(e.id, lamports);
      totalSOL += lamports;
      balances.push({
        name: state.solWallets.find(w => w.id === e.id)?.name || e.id,
        balance: lamports,
        address: e.pubkey.toBase58(),
      });
    });

    return { totalSOL, balances };
  } catch (e) {
    console.error('[SOL] 加载余额失败:', e.message);
    return { totalSOL: 0n, balances: [] };
  }
}

// SOL 签名并发送交易（直接本地签名，替代 background service worker）
export async function solSignAndSend(walletId, { txBase64, rpcUrl, jitoTipLamports }) {
  const kp = state.solKeypairs.get(walletId);
  if (!kp) throw new Error('SOL 钱包未初始化: ' + walletId);

  try {
    const txBuf = Buffer.from(txBase64, 'base64');
    const tx = Transaction.from(txBuf);
    tx.sign(kp);
    const raw = tx.serialize();
    const rawBase64 = raw.toString('base64');

    const conn = new Connection(rpcUrl, 'confirmed');
    const sends = [conn.sendRawTransaction(raw, { skipPreflight: true, maxRetries: 2 })];

    if (jitoTipLamports > 0) {
      sends.push(sendToJito(rawBase64));
    }

    const [sig] = await Promise.all(sends);
    return { signature: sig };
  } catch (e) {
    return { error: e.message };
  }
}

async function sendToJito(rawBase64) {
  const body = JSON.stringify({
    jsonrpc: '2.0', id: 1, method: 'sendTransaction',
    params: [rawBase64, { encoding: 'base64' }],
  });

  const results = await Promise.allSettled(
    JITO_BLOCK_ENGINES.map(url =>
      fetch(`${url}/api/v1/transactions`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body,
      }).then(r => r.json())
    )
  );

  let accepted = 0;
  for (const r of results) {
    if (r.status === 'fulfilled' && r.value?.result) accepted++;
  }
  console.log(`[JITO] 广播到 ${JITO_BLOCK_ENGINES.length} 个引擎, ${accepted} 个接受`);
}

// 列出钱包
export function listSolWallets() {
  const wallets = [];
  for (const w of state.solWallets) {
    const pubkey = state.solAddresses.get(w.id);
    const isActive = state.solActiveWalletIds.includes(w.id);
    wallets.push({
      id: w.id,
      name: w.name,
      address: pubkey?.toBase58() || '(未初始化)',
      active: isActive,
      balance: state.solWalletBalances.get(w.id) || 0n,
    });
  }
  return wallets;
}
