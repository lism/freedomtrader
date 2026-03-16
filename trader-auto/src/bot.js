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
    log('AUTO', `钱包地址: ${this.executor.address}`);
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
    if (this.storage.hasSeen(candidate.address)) return;
    if (this.storage.getOpenPositions().length >= this.config.maxOpenPositions) return;
    const tokenAddrLower = candidate.address.toLowerCase();
    if (this.config.tokenAllowlist.length > 0 && !this.config.tokenAllowlist.map(a => a.toLowerCase()).includes(tokenAddrLower)) return;
    if (this.config.tokenBlocklist.map(a => a.toLowerCase()).includes(tokenAddrLower)) return;

    if (!candidate.creator && candidate.txHash) {
      try {
        candidate.creator = await this.executor.getTransactionSender(candidate.txHash);
      } catch {}
    }
    if (candidate.creator && this.config.creatorBlocklist.map(c => c.toLowerCase()).includes(candidate.creator.toLowerCase())) {
      await this.storage.markSeen(candidate.address);
      log('AUTO', `跳过 ${candidate.symbol}，creator 在黑名单: ${candidate.creator}`);
      return;
    }

    await this.storage.markSeen(candidate.address);

    if (candidate.progress < this.config.minProgressPercent) {
      log('AUTO', `跳过 ${candidate.symbol}，进度过低: ${candidate.progress}`);
      return;
    }

    const info = await this.executor.getTokenInfo(candidate.address);
    if (info.symbol && (candidate.symbol === 'UNKNOWN' || candidate.symbol === 'PAIR_CREATED')) {
      candidate.symbol = info.symbol;
    }
    const taxPercent = Number(info.taxFeeRate || 0n) / 100;
    if (info.routeSource === 0) {
      log('AUTO', `跳过 ${candidate.symbol}，尚无可交易路由`);
      return;
    }
    if (taxPercent > this.config.maxTaxPercent) {
      log('AUTO', `跳过 ${candidate.symbol}，税率过高: ${taxPercent}%`);
      return;
    }

    const liquidityWei = this.executor.getLiquidityBnb(info, candidate.address);
    const liquidityBnb = Number(formatUnits(liquidityWei, 18));
    if (liquidityBnb < this.config.minLiquidityBnb) {
      log('AUTO', `跳过 ${candidate.symbol}，流动性不足: ${liquidityBnb.toFixed(4)} BNB`);
      return;
    }

    if (candidate.pair && this.config.minFirstSwapBnb > 0) {
      const firstSwapWei = await this.executor.getFirstSwapValueBnb(
        candidate.pair,
        candidate.blockNumber || 0,
        candidate.token0,
        candidate.token1,
      );
      const firstSwapBnb = Number(formatUnits(firstSwapWei, 18));
      if (firstSwapBnb < this.config.minFirstSwapBnb) {
        log('AUTO', `跳过 ${candidate.symbol}，首笔成交额不足: ${firstSwapBnb.toFixed(4)} BNB`);
        return;
      }
    }

    log('AUTO', `命中新币 ${candidate.symbol} ${candidate.address}`);

    if (this.config.dryRun) {
      const quote = await this.executor.estimateBuy(candidate.address, parseUnits(String(this.config.buyAmountBnb), 18));
      log('BUY', `DRY_RUN 买入报价 ${candidate.symbol}: ${formatUnits(quote, info.decimals)}`);
      return;
    }

    const trade = await this.executor.buy(candidate.address, parseUnits(String(this.config.buyAmountBnb), 18));
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
      const amountWei = await this.executor.getTokenBalance(position.token);
      if (amountWei <= 0n) {
        await this.storage.updatePosition(position.token, { status: 'closed', closedAt: Date.now(), closeReason: 'balance_zero' });
        return;
      }

      const info = await this.executor.getTokenInfo(position.token);
      const currentValueWei = await this.executor.estimateSell(position.token, amountWei);
      const roiPct = calcRoiPercent(BigInt(position.costWei), currentValueWei);
      await this.storage.updatePosition(position.token, {
        amountWei: amountWei.toString(),
        lastQuoteWei: currentValueWei.toString(),
        lastRoiPct: roiPct,
        checkedAt: Date.now(),
      });

      log('PNL', `${position.symbol} ${formatPercent(roiPct)} | 估值 ${formatUnits(currentValueWei, 18)} BNB`);

      if (roiPct >= this.config.takeProfitPercent) {
        await this.closePosition(position, amountWei, info, 'take_profit');
        return;
      }
      if (roiPct <= -Math.abs(this.config.stopLossPercent)) {
        await this.closePosition(position, amountWei, info, 'stop_loss');
      }
    } catch (error) {
      logError('PNL', `监控持仓失败 ${position.symbol}`, error);
    }
  }

  async closePosition(position, amountWei, info, reason) {
    const sellPercent = Math.min(100, Math.max(0, this.config.autoSellPercent || 100));
    const sellAmountWei = (amountWei * BigInt(Math.floor(sellPercent * 100))) / 10000n;
    if (sellAmountWei <= 0n) return;

    if (this.config.dryRun) {
      const quote = await this.executor.estimateSell(position.token, sellAmountWei);
      log('SELL', `DRY_RUN 卖出 ${position.symbol} (${sellPercent}%) | reason=${reason} | quote=${formatUnits(quote, 18)} BNB`);
      return;
    }

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
