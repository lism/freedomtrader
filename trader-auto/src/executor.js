import { createPublicClient, createWalletClient, formatUnits, http, webSocket, parseAbiItem, parseUnits } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { bsc } from 'viem/chains';
import {
  DEFAULT_TIP_RATE,
  ERC20_ABI,
  FREEDOM_ROUTER,
  ROUTE,
  ROUTER_ABI,
  TOKEN_MANAGER_V2,
  WBNB,
  ZERO_ADDR,
} from './constants.js';
import { clamp } from './utils.js';

const MAX_UINT256 = BigInt('0xffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff');
const MAX_HALF = BigInt('0x7fffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff');
const SWAP_EVENT = parseAbiItem(
  'event Swap(address indexed sender, uint256 amount0In, uint256 amount1In, uint256 amount0Out, uint256 amount1Out, address indexed to)'
);

export class BscExecutor {
  constructor(config) {
    this.config = config;
    this.account = privateKeyToAccount(config.privateKey);
    const transport = config.rpcUrl && config.rpcUrl.startsWith('ws') ? webSocket(config.rpcUrl) : http(config.rpcUrl);
    this.publicClient = createPublicClient({ chain: bsc, transport });
    this.walletClient = createWalletClient({ account: this.account, chain: bsc, transport });
  }

  get address() {
    return this.account.address;
  }

  async getTokenInfo(token) {
    const info = await this.publicClient.readContract({
      address: FREEDOM_ROUTER,
      abi: ROUTER_ABI,
      functionName: 'getTokenInfo',
      args: [token, this.address],
    });
    return info;
  }

  async getTokenBalance(token) {
    return this.publicClient.readContract({
      address: token,
      abi: ERC20_ABI,
      functionName: 'balanceOf',
      args: [this.address],
    });
  }

  async getAllowance(token, spender) {
    return this.publicClient.readContract({
      address: token,
      abi: ERC20_ABI,
      functionName: 'allowance',
      args: [this.address, spender],
    });
  }

  async getTransactionSender(hash) {
    const tx = await this.publicClient.getTransaction({ hash });
    return tx.from.toLowerCase();
  }

  getSellApproveTarget(info) {
    if (info.approveTarget && info.approveTarget !== ZERO_ADDR) return info.approveTarget;
    if (info.isInternal) return TOKEN_MANAGER_V2;
    return FREEDOM_ROUTER;
  }

  getTipRate() {
    const pct = clamp(Number(this.config.tipRate ?? DEFAULT_TIP_RATE), 0, 5);
    return BigInt(Math.floor(pct * 100));
  }

  getSlipBps() {
    return BigInt(Math.floor((100 - this.config.slippagePercent) * 100));
  }

  getLiquidityBnb(info, token) {
    const route = Number(info.routeSource || 0);
    if (info.isInternal) return info.tmFunds || 0n;
    if (route === ROUTE.FLAP_BONDING || route === ROUTE.FLAP_BONDING_SELL || route === ROUTE.FLAP_DEX) {
      return info.flapReserve || 0n;
    }
    const tokenLower = token.toLowerCase() < WBNB.toLowerCase();
    return tokenLower ? (info.pairReserve1 || 0n) : (info.pairReserve0 || 0n);
  }

  async getFirstSwapValueBnb(pair, fromBlock, token0, token1) {
    const logs = await this.publicClient.getLogs({
      address: pair,
      event: SWAP_EVENT,
      fromBlock: BigInt(fromBlock),
      toBlock: await this.publicClient.getBlockNumber(),
    });
    if (logs.length === 0) return 0n;

    const first = logs[0];
    const isToken0Wbnb = token0 === WBNB.toLowerCase();
    const wbnbIn = isToken0Wbnb ? (first.args.amount0In || 0n) : (first.args.amount1In || 0n);
    const wbnbOut = isToken0Wbnb ? (first.args.amount0Out || 0n) : (first.args.amount1Out || 0n);
    return wbnbIn > 0n ? wbnbIn : wbnbOut;
  }

  async estimateBuy(token, amountWei) {
    const estimated = await this.publicClient.readContract({
      address: FREEDOM_ROUTER,
      abi: ROUTER_ABI,
      functionName: 'quoteBuy',
      args: [token, amountWei],
    });
    return (estimated * this.getSlipBps()) / 10000n;
  }

  async estimateSell(token, amountWei) {
    const estimated = await this.publicClient.readContract({
      address: FREEDOM_ROUTER,
      abi: ROUTER_ABI,
      functionName: 'quoteSell',
      args: [token, amountWei],
    });
    return (estimated * this.getSlipBps()) / 10000n;
  }

  async ensureApproved(token, spender, minAllowance) {
    const allowance = await this.getAllowance(token, spender);
    if (allowance >= minAllowance) return null;

    const hash = await this.walletClient.writeContract({
      address: token,
      abi: ERC20_ABI,
      functionName: 'approve',
      args: [spender, MAX_UINT256],
      gas: 150000n,
      gasPrice: parseUnits(String(this.config.gasPriceGwei), 9),
    });
    await this.publicClient.waitForTransactionReceipt({ hash, timeout: 120000 });
    return hash;
  }

  async buy(token) {
    const value = parseUnits(String(this.config.buyAmountBnb), 18);
    const amountOutMin = await this.estimateBuy(token, value);
    const deadline = BigInt(Math.floor(Date.now() / 1000) + 10);

    const before = await this.getTokenBalance(token);
    const hash = await this.walletClient.writeContract({
      address: FREEDOM_ROUTER,
      abi: ROUTER_ABI,
      functionName: 'buy',
      args: [token, amountOutMin, this.getTipRate(), deadline],
      value,
      gas: 800000n,
      gasPrice: parseUnits(String(this.config.gasPriceGwei), 9),
    });
    await this.publicClient.waitForTransactionReceipt({ hash, timeout: 120000 });
    const after = await this.getTokenBalance(token);

    return {
      txHash: hash,
      costWei: value,
      boughtAmountWei: after > before ? after - before : 0n,
    };
  }

  async sell(token, amountWei, info) {
    const approveTarget = this.getSellApproveTarget(info);
    if ((await this.getAllowance(token, approveTarget)) < amountWei && amountWei <= MAX_HALF) {
      await this.ensureApproved(token, approveTarget, amountWei);
    }

    const amountOutMin = await this.estimateSell(token, amountWei);
    const deadline = BigInt(Math.floor(Date.now() / 1000) + 10);
    const hash = await this.walletClient.writeContract({
      address: FREEDOM_ROUTER,
      abi: ROUTER_ABI,
      functionName: 'sell',
      args: [token, amountWei, amountOutMin, this.getTipRate(), deadline],
      gas: 800000n,
      gasPrice: parseUnits(String(this.config.gasPriceGwei), 9),
    });
    await this.publicClient.waitForTransactionReceipt({ hash, timeout: 120000 });
    return {
      txHash: hash,
      estimatedOutWei: amountOutMin,
    };
  }

  formatToken(amountWei, decimals) {
    return formatUnits(amountWei, decimals);
  }

  // ========== 合约安全检查 ==========

  async checkContractSafety(token) {
    const issues = [];
    const checks = {};

    try {
      // 1. 检查合约是否有 owner 函数
      try {
        const owner = await this.publicClient.readContract({
          address: token,
          abi: ERC20_ABI,
          functionName: 'owner',
        });
        checks.hasOwner = true;
        checks.owner = owner;
        if (owner !== ZERO_ADDR) {
          issues.push('合约拥有 owner，存在中心化风险');
        }
      } catch (e) {
        checks.hasOwner = false;
      }

      // 2. 检查是否有 mint 功能
      try {
        const hasMint = await this.publicClient.readContract({
          address: token,
          abi: ERC20_ABI,
          functionName: 'mint',
          args: ['0x0000000000000000000000000000000000000001', 1n],
        });
        checks.hasMint = true;
        issues.push('合约存在 mint 功能，可无限增发');
      } catch (e) {
        checks.hasMint = false;
      }

      // 3. 检查是否是黑/白名单合约
      try {
        const isBlacklisted = await this.publicClient.readContract({
          address: token,
          abi: ERC20_ABI,
          functionName: 'isBlacklisted',
          args: [this.address],
        });
        checks.isBlacklisted = isBlacklisted;
        if (isBlacklisted) {
          issues.push('地址被加入黑名单，无法交易');
        }
      } catch (e) {
        checks.isBlacklisted = false;
      }

    } catch (error) {
      console.warn('[Safety Check] 检查失败:', error.message);
    }

    return { checks, issues, isSafe: issues.length === 0 };
  }

  async getHolderDistribution(token) {
    try {
      const totalSupply = await this.publicClient.readContract({
        address: token,
        abi: ERC20_ABI,
        functionName: 'totalSupply',
      });

      // 获取前 20 大持有者（简化版，实际需要通过事件或子图）
      // 这里返回 placeholder，因为需要更复杂的数据源
      return {
        totalSupply,
        top10Percentage: 0n,
        holderCount: 0,
      };
    } catch (error) {
      console.warn('[Holder Check] 获取失败:', error.message);
      return null;
    }
  }

  async validateToken(token, creator) {
    const errors = [];
    const warnings = [];

    // 1. 检查流动性
    const info = await this.getTokenInfo(token);
    const liquidity = this.getLiquidityBnb(info, token);
    const minLiqWei = BigInt(Math.floor(this.config.minLiquidityBnb * 1e18));
    if (liquidity < minLiqWei) {
      errors.push(`流动性不足：${formatUnits(liquidity, 18)} BNB < ${this.config.minLiquidityBnb} BNB`);
    }

    // 2. 检查税收
    const taxPercent = Number(info.taxFeeRate || 0n) / 100;
    if (taxPercent > this.config.maxTaxPercent) {
      errors.push(`税收过高：${taxPercent}% > ${this.config.maxTaxPercent}%`);
    }

    // 3. 检查合约是否拥有 owner（高风险）
    try {
      const owner = await this.publicClient.readContract({
        address: token,
        abi: ERC20_ABI,
        functionName: 'owner',
      });
      if (owner !== ZERO_ADDR) {
        errors.push(`合约拥有 owner（中心化风险）：${owner}`);
      }
    } catch (e) {
      // 没有 owner 函数，可能是安全的
    }

    // 4. 检查合约是否有 mint 功能（可无限增发）
    try {
      await this.publicClient.readContract({
        address: token,
        abi: ERC20_ABI,
        functionName: 'mint',
        args: ['0x0000000000000000000000000000000000000001', 1n],
      });
      errors.push(`合约存在 mint 功能（可无限增发）`);
    } catch (e) {
      // 没有 mint 函数，可能是安全的
    }

    // 5. 检查创建者白名单
    if (creator) {
      const creatorLower = creator.toLowerCase();
      if (this.config.creatorBlocklist && this.config.creatorBlocklist.map(c => c.toLowerCase()).includes(creatorLower)) {
        errors.push(`创建者在黑名单：${creator}`);
      }
      if (this.config.creatorWhitelist && this.config.creatorWhitelist.length > 0 &&
          !this.config.creatorWhitelist.map(c => c.toLowerCase()).includes(creatorLower)) {
        warnings.push(`创建者不在白名单：${creator}`);
      }
    }

    return { errors, warnings, isValid: errors.length === 0 };
  }
}
