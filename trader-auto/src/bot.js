import { formatUnits, parseUnits } from 'viem';
import { log, logError } from './logger.js';
import { formatPercent, sleep } from './utils.js';

function calcRoiPercent(costWei, currentValueWei) {
  if (costWei <= 0n) return 0;
  const roi = ((currentValueWei - costWei) * 10000n) / costWei;
  return Number(roi) / 100;
}

export class TraderAutoBot {
  constructor({ config, storage, monitor, onchainMonitor, executor }) {
    this.config = config;
    this.storage = storage;
    this.monitor = monitor;
    this.onchainMonitor = onchainMonitor;
    this.executor = executor;
    this.running = false;
    this.lastScanAt = 0;
    this.lastMonitorAt = 0;
  }

  async start() {
    this.running = true;
    log('AUTO', `钱包地址：${this.executor.address}`);
    log('AUTO', this.config.dryRun ? '当前为 DRY_RUN，只做信号与报价' : '当前为真实交易模式');

    while (this.running) {
      const now = Date.now();
      if (now - this.lastScanAt >= this.config.scanIntervalMs) {
        await this.runScanCycle();
        this.lastScanAt = now;
      }
      if (now - this.lastMonitorAt >= this.config.monitorIntervalMs) {
        await this.runMonitorCycle();
        this.lastMonitorAt = now;
      }
      await sleep(500);
    }
  }

  stop() {
    this.running = false;
  }

  async runScanCycle() {
    try {
      const [fourCandidates, onchainCandidates] = await Promise.all([
        this.monitor.poll(),
        this.onchainMonitor.poll(),
      ]);
      const candidates = [...fourCandidates, ...onchainCandidates];
      for (const candidate of candidates) {
        await this.handleCandidate(candidate);
      }
    } catch (error) {
      logError('AUTO', '扫描周期失败', error);
    }
  }

  async handleCandidate(candidate) {
    const tokenAddrLower = candidate.address.toLowerCase();

    // 1. 检查是否已达到最大持仓限制
    const openPositions = this.storage.getOpenPositions();
    if (openPositions.length >= this.config.maxOpenPositions) return;

    // 2. 检查是否已经见过这个代币（避免重复处理）
    if (this.storage.hasSeen(tokenAddrLower)) {
      return;
    }

    // 3. 检查白名单/黑名单
    if (this.config.tokenAllowlist.length > 0 && !this.config.tokenAllowlist.map(a => a.toLowerCase()).includes(tokenAddrLower)) {
      return;
    }
    if (this.config.tokenBlocklist.map(a => a.toLowerCase()).includes(tokenAddrLower)) {
      return;
    }

    // 4. 获取创建者地址
    if (!candidate.creator && candidate.txHash) {
      try {
        candidate.creator = await this.executor.getTransactionSender(candidate.txHash);
      } catch {}
    }

    // 5. 检查创建者黑名单
    if (candidate.creator && this.config.creatorBlocklist.map(c => c.toLowerCase()).includes(candidate.creator.toLowerCase())) {
      await this.storage.markSeen(candidate.address);
      return;
    }

    // 6. 获取代币信息
    const info = await this.executor.getTokenInfo(candidate.address);
    if (info.symbol && (candidate.symbol === 'UNKNOWN' || candidate.symbol === 'PAIR_CREATED')) {
      candidate.symbol = info.symbol;
    }

    // 7. 检查可交易路由
    if (info.routeSource === 0) {
      return;
    }

    // 8. 检查税收
    const taxPercent = Number(info.taxFeeRate || 0n) / 100;
    if (taxPercent > this.config.maxTaxPercent) {
      return;
    }

    // 9. 检查流动性
    const liquidityWei = this.executor.getLiquidityBnb(info, candidate.address);
    const liquidityBnb = Number(formatUnits(liquidityWei, 18));
    if (liquidityBnb < this.config.minLiquidityBnb) {
      return;
    }

    // 10. 检查首笔成交额
    if (candidate.pair && this.config.minFirstSwapBnb > 0) {
      const firstSwapWei = await this.executor.getFirstSwapValueBnb(
        candidate.pair,
        candidate.blockNumber || 0,
        candidate.token0,
        candidate.token1,
      );
      const firstSwapBnb = Number(formatUnits(firstSwapWei, 18));
      if (firstSwapBnb < this.config.minFirstSwapBnb) {
        return;
      }
    }

    // 11. 合约安全检查（owner, mint 等）
    const validation = await this.executor.validateToken(candidate.address, candidate.creator);
    if (!validation.isValid) {
      return;
    }

    // 12. 检查创建者白名单
    if (candidate.creator && this.config.creatorWhitelist && this.config.creatorWhitelist.length > 0) {
      const creatorLower = candidate.creator.toLowerCase();
      if (!this.config.creatorWhitelist.map(c => c.toLowerCase()).includes(creatorLower)) {
        // 创建者不在白名单，跳过
        await this.storage.markSeen(candidate.address);
        return;
      }
    }

    // 13. 进度检查
    if (candidate.progress < this.config.minProgressPercent) {
      return;
    }

    // 14. 标记为已见（在所有检查通过后）
    await this.storage.markSeen(candidate.address);
    log('AUTO', `命中新币 ${candidate.symbol} ${candidate.address}`);

    // 估算买入能获得的代币数量（用于模拟持仓）
    const buyAmountWei = parseUnits(String(this.config.buyAmountBnb), 18);
    const tokensReceived = await this.executor.estimateBuy(candidate.address, buyAmountWei);

    // 检查是否为模拟模式（SIMULATE_MODE）
    if (this.config.simulateMode) {
      // 模拟买入：记录持仓但不执行真实交易
      await this.storage.addPosition({
        token: candidate.address,
        symbol: candidate.symbol,
        decimals: Number(info.decimals),
        status: 'open',
        openedAt: Date.now(),
        costWei: buyAmountWei.toString(),
        amountWei: tokensReceived.toString(),
        buyTxHash: 'SIMULATED',
        lastQuoteWei: tokensReceived.toString(), // 初始估值 = 买入数量
        lastRoiPct: 0,
        creator: candidate.creator || null,
      });
      log('BUY_SIM', `模拟买入 ${candidate.symbol} | 投入 ${formatUnits(buyAmountWei, 18)} BNB | 获得 ${formatUnits(tokensReceived, info.decimals)} 代币`);
      return;
    }

    if (this.config.dryRun) {
      log('BUY', `DRY_RUN 买入报价 ${candidate.symbol}: ${formatUnits(tokensReceived, info.decimals)}`);
      return;
    }

    // 真实交易模式
    const trade = await this.executor.buy(candidate.address, buyAmountWei);
    if (trade.boughtAmountWei <= 0n) {
      log('BUY', `买入后未检测到持仓增加，跳过建仓 ${candidate.symbol}`);
      return;
    }

    await this.storage.addPosition({
      token: candidate.address,
      symbol: candidate.symbol,
      decimals: Number(info.decimals),
      status: 'open',
      openedAt: Date.now(),
      costWei: trade.costWei.toString(),
      amountWei: trade.boughtAmountWei.toString(),
      buyTxHash: trade.txHash,
      lastQuoteWei: '0',
      lastRoiPct: 0,
      creator: candidate.creator || null,
    });
    log('BUY', `已建仓 ${candidate.symbol} 数量 ${formatUnits(trade.boughtAmountWei, info.decimals)}`);
  }

  async runMonitorCycle() {
    const positions = this.storage.getOpenPositions();
    await Promise.allSettled(positions.map(position => this.monitorPosition(position)));
  }

  async monitorPosition(position) {
    try {
      // 模拟模式下，使用模拟持仓数量；真实模式下查询实际余额
      let amountWei;
      if (this.config.simulateMode) {
        amountWei = BigInt(position.amountWei);
      } else {
        amountWei = await this.executor.getTokenBalance(position.token);
        if (amountWei <= 0n) {
          await this.storage.updatePosition(position.token, { status: 'closed', closedAt: Date.now(), closeReason: 'balance_zero' });
          return;
        }
      }

      const info = await this.executor.getTokenInfo(position.token);
      const currentValueWei = await this.executor.estimateSell(position.token, amountWei);
      const roiPct = calcRoiPercent(BigInt(position.costWei), currentValueWei);

      // 检查止盈/止损
      let closeReason = null;
      if (roiPct >= this.config.takeProfitPercent) {
        closeReason = 'take_profit';
      } else if (roiPct <= -Math.abs(this.config.stopLossPercent)) {
        closeReason = 'stop_loss';
      }

      // 更新持仓信息
      await this.storage.updatePosition(position.token, {
        amountWei: amountWei.toString(),
        lastQuoteWei: currentValueWei.toString(),
        lastRoiPct: roiPct,
        checkedAt: Date.now(),
        closeReason: closeReason,
      });

      // 输出 PNL 信息
      if (closeReason) {
        log('PNL', `${position.symbol} ${formatPercent(roiPct)} | 估值 ${formatUnits(currentValueWei, 18)} BNB | 触发${closeReason === 'take_profit' ? '止盈' : '止损'}`);
      } else {
        log('PNL', `${position.symbol} ${formatPercent(roiPct)} | 估值 ${formatUnits(currentValueWei, 18)} BNB`);
      }

      // 执行卖出操作（模拟或真实）
      if (closeReason) {
        await this.closePosition(position, amountWei, info, closeReason);
      }
    } catch (error) {
      logError('PNL', `监控持仓失败 ${position.symbol}`, error);
    }
  }

  async closePosition(position, amountWei, info, reason) {
    const sellPercent = Math.min(100, Math.max(0, this.config.autoSellPercent || 100));
    const sellAmountWei = (amountWei * BigInt(Math.floor(sellPercent * 100))) / 10000n;
    if (sellAmountWei <= 0n) return;

    // 估算卖出能收到的 BNB 数量
    const estimatedOutWei = await this.executor.estimateSell(position.token, sellAmountWei);
    const estimatedOutBnb = Number(formatUnits(estimatedOutWei, 18));

    // 模拟模式：记录卖出但不执行真实交易
    if (this.config.simulateMode) {
      const isFullClose = sellPercent >= 100 || sellAmountWei >= amountWei;
      const newAmount = amountWei - sellAmountWei;

      await this.storage.updatePosition(position.token, {
        status: isFullClose ? 'closed' : 'open',
        amountWei: newAmount.toString(),
        closedAt: isFullClose ? Date.now() : position.closedAt,
        closeReason: isFullClose ? reason : position.closeReason,
        sellTxHash: 'SIMULATED',
        exitQuoteWei: estimatedOutWei.toString(),
      });

      const finalRoi = calcRoiPercent(BigInt(position.costWei), estimatedOutWei);
      log('SELL_SIM', `模拟卖出 ${position.symbol} (${sellPercent}%) | reason=${reason} | 收到 ${estimatedOutBnb.toFixed(4)} BNB | ROI ${formatPercent(finalRoi)}`);
      return;
    }

    if (this.config.dryRun) {
      log('SELL', `DRY_RUN 卖出 ${position.symbol} (${sellPercent}%) | reason=${reason} | quote=${estimatedOutBnb.toFixed(4)} BNB`);
      return;
    }

    // 真实交易模式
    const trade = await this.executor.sell(position.token, sellAmountWei, info);

    const isFullClose = sellPercent >= 100 || sellAmountWei >= amountWei;
    const newAmount = amountWei - sellAmountWei;

    await this.storage.updatePosition(position.token, {
      status: isFullClose ? 'closed' : 'open',
      amountWei: newAmount.toString(),
      closedAt: isFullClose ? Date.now() : position.closedAt,
      closeReason: isFullClose ? reason : position.closeReason,
      sellTxHash: trade.txHash,
      exitQuoteWei: trade.estimatedOutWei.toString(),
    });
    log('SELL', `已卖出 ${position.symbol} (${sellPercent}%) | reason=${reason}`);
  }
}