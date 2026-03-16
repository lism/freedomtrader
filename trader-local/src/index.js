#!/usr/bin/env node
// Freedom Trader 本地系统 - CLI 入口
// 用法:
//   node src/index.js wallet add --name "主钱包" --chain bsc --key 0x...
//   node src/index.js wallet list
//   node src/index.js wallet balance
//   node src/index.js info <token_address>
//   node src/index.js buy <token_address> <amount>
//   node src/index.js sell <token_address> <amount|percent%>
//   node src/index.js config set <key> <value>
//   node src/index.js config show

import { formatUnits } from 'viem';
import { state } from './state.js';
import { loadConfig, saveConfig, setConfig } from './config.js';
import { setPassword, unlock, hasPassword, isUnlocked } from './crypto.js';
import { initWalletClients, addBscWallet, loadBscBalances, listBscWallets } from './wallet-bsc.js';
import { initSolWallets, addSolWallet, loadSolBalances, listSolWallets } from './wallet-sol.js';
import { detectBscToken } from './token-bsc.js';
import { detectSolToken } from './token-sol.js';
import { buy as bscBuy, sell as bscSell, loadApprovedTokens } from './trading-bsc.js';
import { solBuy, solSell } from './trading-sol.js';
import { executeBatchTrade, fastBuy, fastSell } from './batch.js';
import { detectChain, normalizeAmount, isValidAddress, isValidSolAddress } from './utils.js';
import { setConnection } from './sol/connection.js';
import { createInterface } from 'readline';

const args = process.argv.slice(2);

// ─── 密码输入（隐藏）─────────────────────────────────────────────────

function askPassword(prompt) {
  return new Promise((resolve) => {
    const rl = createInterface({
      input: process.stdin,
      output: process.stdout,
    });
    // 在 Windows 上无法真正隐藏输入，提示用户
    rl.question(prompt, (answer) => {
      rl.close();
      resolve(answer);
    });
  });
}

// ─── 初始化钱包 ─────────────────────────────────────────────────

async function ensureUnlocked() {
  if (isUnlocked()) return;

  if (!hasPassword()) {
    console.log('🔐 首次使用，请设置加密密码:');
    const pw = await askPassword('  密码: ');
    if (!pw) {
      console.error('❌ 密码不能为空');
      process.exit(1);
    }
    setPassword(pw);
    return;
  }

  const pw = await askPassword('🔐 请输入密码解锁: ');
  if (!unlock(pw)) {
    console.error('❌ 密码错误');
    process.exit(1);
  }
}

async function initAll() {
  await ensureUnlocked();
  const config = loadConfig();

  // 初始化 BSC
  try {
    await initWalletClients();
  } catch (e) {
    console.warn('[INIT] BSC 钱包初始化跳过:', e.message);
  }

  // 初始化 SOL
  try {
    if (config.solRpcUrl) {
      setConnection(config.solRpcUrl, config.solWssUrl);
    }
    await initSolWallets();
  } catch (e) {
    console.warn('[INIT] SOL 钱包初始化跳过:', e.message);
  }

  loadApprovedTokens();
}

// ─── 命令处理 ─────────────────────────────────────────────────

async function handleWallet(subArgs) {
  const subcmd = subArgs[0];

  if (subcmd === 'add') {
    await ensureUnlocked();
    const params = parseFlags(subArgs.slice(1));
    const name = params.name || `钱包${Date.now()}`;
    const chain = params.chain || 'bsc';
    const key = params.key;

    if (!key) {
      console.error('❌ 请提供私钥: --key <privateKey>');
      process.exit(1);
    }

    if (chain === 'sol') {
      addSolWallet(name, key);
    } else {
      addBscWallet(name, key);
    }
    return;
  }

  if (subcmd === 'list') {
    await initAll();
    console.log('\n📋 BSC 钱包:');
    const bscWallets = listBscWallets();
    if (bscWallets.length === 0) {
      console.log('  (无)');
    } else {
      for (const w of bscWallets) {
        const badge = w.active ? '✓' : ' ';
        console.log(`  [${badge}] ${w.name} | ${w.address}`);
      }
    }

    console.log('\n📋 SOL 钱包:');
    const solWallets = listSolWallets();
    if (solWallets.length === 0) {
      console.log('  (无)');
    } else {
      for (const w of solWallets) {
        const badge = w.active ? '✓' : ' ';
        console.log(`  [${badge}] ${w.name} | ${w.address}`);
      }
    }
    return;
  }

  if (subcmd === 'balance') {
    await initAll();
    console.log('\n💰 BSC 余额:');
    const { totalBNB, balances: bscBals } = await loadBscBalances();
    if (bscBals.length === 0) {
      console.log('  (无钱包)');
    } else {
      for (const b of bscBals) {
        console.log(`  ${b.name}: ${parseFloat(formatUnits(b.balance, 18)).toFixed(4)} BNB | ${b.address}`);
      }
      console.log(`  总计: ${parseFloat(formatUnits(totalBNB, 18)).toFixed(4)} BNB`);
    }

    console.log('\n💰 SOL 余额:');
    const { totalSOL, balances: solBals } = await loadSolBalances();
    if (solBals.length === 0) {
      console.log('  (无钱包)');
    } else {
      for (const b of solBals) {
        console.log(`  ${b.name}: ${(Number(b.balance) / 1e9).toFixed(4)} SOL | ${b.address}`);
      }
      console.log(`  总计: ${(Number(totalSOL) / 1e9).toFixed(4)} SOL`);
    }
    return;
  }

  printHelp();
}

async function handleInfo(subArgs) {
  const addr = subArgs[0];
  if (!addr) {
    console.error('❌ 请提供代币地址');
    return;
  }

  await initAll();

  const chain = detectChain(addr);
  if (chain === 'sol') {
    state.currentChain = 'sol';
    await detectSolToken(addr);
  } else if (chain === 'bsc') {
    state.currentChain = 'bsc';
    await detectBscToken(addr);
  } else {
    console.error('❌ 无法识别地址格式');
  }
}

async function handleBuy(subArgs) {
  const addr = subArgs[0];
  const amount = subArgs[1];
  const params = parseFlags(subArgs.slice(2));

  if (!addr || !amount) {
    console.error('❌ 用法: buy <token_address> <amount> [--slippage 15] [--gas 3]');
    return;
  }

  await initAll();

  const chain = params.chain || detectChain(addr);
  state.currentChain = chain;

  // 先检测代币
  if (chain === 'sol') {
    await detectSolToken(addr);
  } else {
    await detectBscToken(addr);
  }

  if (!state.lpInfo.hasLP) {
    console.error('❌ 未找到 LP，无法交易');
    return;
  }

  const config = loadConfig();
  const slippage = parseFloat(params.slippage || config.slippage || 15);
  const gasPrice = parseFloat(params.gas || config.gasPrice || 3);

  console.log(`\n🛒 买入 ${amount} ${chain === 'sol' ? 'SOL' : 'BNB'} 的 ${state.tokenInfo.symbol}...`);

  const activeWallets = chain === 'sol'
    ? state.solActiveWalletIds.filter(id => state.solAddresses.has(id))
    : state.activeWalletIds.filter(id => state.walletClients.has(id));

  if (activeWallets.length === 0) {
    console.error('❌ 没有可用的钱包');
    return;
  }

  if (activeWallets.length > 1) {
    // 批量买入
    await fastBuy(addr, amount);
  } else {
    // 单钱包买入
    try {
      let result;
      if (chain === 'sol') {
        result = await solBuy(activeWallets[0], addr, parseFloat(normalizeAmount(amount)), slippage);
      } else {
        result = await bscBuy(activeWallets[0], addr, amount, gasPrice);
      }
      console.log(`\n🎉 买入成功! txHash: ${result.txHash}`);
    } catch (e) {
      console.error('❌ 买入失败:', e.message);
    }
  }
}

async function handleSell(subArgs) {
  const addr = subArgs[0];
  const amount = subArgs[1];
  const params = parseFlags(subArgs.slice(2));

  if (!addr || !amount) {
    console.error('❌ 用法: sell <token_address> <amount|percent%> [--slippage 15] [--gas 3]');
    return;
  }

  await initAll();

  const chain = params.chain || detectChain(addr);
  state.currentChain = chain;

  // 先检测代币
  if (chain === 'sol') {
    await detectSolToken(addr);
  } else {
    await detectBscToken(addr);
  }

  if (!state.lpInfo.hasLP) {
    console.error('❌ 未找到 LP，无法交易');
    return;
  }

  const config = loadConfig();
  const slippage = parseFloat(params.slippage || config.slippage || 15);
  const gasPrice = parseFloat(params.gas || config.gasPrice || 3);

  const isPct = amount.endsWith('%');
  const pct = isPct ? parseInt(amount) : null;
  console.log(`\n💰 卖出 ${amount} 的 ${state.tokenInfo.symbol}...`);

  const activeWallets = chain === 'sol'
    ? state.solActiveWalletIds.filter(id => state.solAddresses.has(id))
    : state.activeWalletIds.filter(id => state.walletClients.has(id));

  if (activeWallets.length === 0) {
    console.error('❌ 没有可用的钱包');
    return;
  }

  if (isPct && activeWallets.length >= 1) {
    // 按百分比卖出
    await fastSell(addr, pct);
  } else if (activeWallets.length > 1) {
    // 批量卖出
    state.tradeMode = 'sell';
    await executeBatchTrade(addr, amount, 'sell');
  } else {
    // 单钱包卖出
    try {
      let result;
      if (chain === 'sol') {
        result = await solSell(activeWallets[0], addr, amount, slippage);
      } else {
        result = await bscSell(activeWallets[0], addr, amount, gasPrice);
      }
      console.log(`\n🎉 卖出成功! txHash: ${result.txHash}`);
    } catch (e) {
      console.error('❌ 卖出失败:', e.message);
    }
  }
}

function handleConfig(subArgs) {
  const subcmd = subArgs[0];

  if (subcmd === 'show') {
    const config = loadConfig();
    console.log('\n⚙️  当前配置:');
    console.log(`  BSC RPC:        ${config.rpcUrl}`);
    console.log(`  SOL RPC:        ${config.solRpcUrl}`);
    console.log(`  SOL WSS:        ${config.solWssUrl || '(自动)'}`);
    console.log(`  Tip Rate:       ${config.tipRate}%`);
    console.log(`  Slippage:       ${config.slippage}%`);
    console.log(`  Gas Price:      ${config.gasPrice} Gwei`);
    console.log(`  SOL Priority:   ${config.solPriorityFee} SOL`);
    console.log(`  SOL Jito Tip:   ${config.solJitoTip} SOL`);
    return;
  }

  if (subcmd === 'set') {
    const key = subArgs[1];
    let value = subArgs[2];
    if (!key || value === undefined) {
      console.error('❌ 用法: config set <key> <value>');
      console.log('  可用 key: rpcUrl, solRpcUrl, solWssUrl, tipRate, slippage, gasPrice, solPriorityFee, solJitoTip');
      return;
    }

    // 尝试转为数字
    if (/^\d+(\.\d+)?$/.test(value)) {
      value = parseFloat(value);
    }

    setConfig(key, value);
    console.log(`✓ ${key} = ${value}`);
    return;
  }

  printHelp();
}

// ─── 辅助工具 ─────────────────────────────────────────────────

function parseFlags(args) {
  const result = {};
  for (let i = 0; i < args.length; i++) {
    if (args[i].startsWith('--') && i + 1 < args.length) {
      result[args[i].slice(2)] = args[i + 1];
      i++;
    }
  }
  return result;
}

function printHelp() {
  console.log(`
╔══════════════════════════════════════════════════════════╗
║          Freedom Trader 本地交易系统 v1.0.0              ║
║          BSC + Solana 双链聚合交易终端                    ║
╚══════════════════════════════════════════════════════════╝

📌 命令:

  wallet add --name "名称" --chain bsc|sol --key <私钥>
    添加钱包

  wallet list
    列出所有钱包

  wallet balance
    查看所有钱包余额

  info <代币地址>
    检测代币信息（自动识别 BSC/SOL）

  buy <代币地址> <数量> [--slippage 15] [--gas 3]
    买入代币

  sell <代币地址> <数量|百分比%> [--slippage 15] [--gas 3]
    卖出代币（例如: sell 0x... 50%）

  config show
    显示当前配置

  config set <key> <value>
    设置配置项
    可用 key: rpcUrl, solRpcUrl, solWssUrl, tipRate,
             slippage, gasPrice, solPriorityFee, solJitoTip

📖 示例:
  node src/index.js wallet add --name "主钱包" --chain bsc --key 0xabc...
  node src/index.js info 0x1234567890abcdef1234567890abcdef12345678
  node src/index.js buy 0x1234...5678 0.01 --slippage 20
  node src/index.js sell 0x1234...5678 50%
  node src/index.js config set slippage 20
`);
}

// ─── 主入口 ─────────────────────────────────────────────────

async function main() {
  const command = args[0];
  const subArgs = args.slice(1);

  try {
    switch (command) {
      case 'wallet':
        await handleWallet(subArgs);
        break;
      case 'info':
        await handleInfo(subArgs);
        break;
      case 'buy':
        await handleBuy(subArgs);
        break;
      case 'sell':
        await handleSell(subArgs);
        break;
      case 'config':
        handleConfig(subArgs);
        break;
      case 'help':
      case '--help':
      case '-h':
      default:
        printHelp();
        break;
    }
  } catch (e) {
    console.error('❌ 错误:', e.message);
    if (process.env.DEBUG) console.error(e.stack);
  }

  // 确保进程退出（避免 WebSocket 连接保持）
  setTimeout(() => process.exit(0), 1000);
}

main();
