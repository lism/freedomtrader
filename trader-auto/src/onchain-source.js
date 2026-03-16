import { parseAbiItem } from 'viem';
import { WBNB } from './constants.js';
import { log } from './logger.js';
import { scanLogsInChunks } from './log-scanner.js';

const PAIR_CREATED_EVENT = parseAbiItem(
  'event PairCreated(address indexed token0, address indexed token1, address pair, uint256)'
);

export class OnchainSource {
  constructor(config, publicClient) {
    this.config = config;
    this.publicClient = publicClient;
    this.lastBlock = null;
  }

  async poll() {
    if (!this.config.enabled) return [];

    const latestBlock = await this.publicClient.getBlockNumber();
    if (this.lastBlock == null) {
      this.lastBlock = this.config.startBlock ?? (latestBlock > 3n ? latestBlock - 3n : latestBlock);
      log('AUTO', `Pancake 监听起始块: ${this.lastBlock.toString()}`);
      return [];
    }

    const fromBlock = this.lastBlock + 1n;
    if (fromBlock > latestBlock) return [];

    const logs = await scanLogsInChunks(
      this.publicClient,
      {
        address: this.config.factory,
        event: PAIR_CREATED_EVENT,
      },
      fromBlock,
      latestBlock,
      this.config.logBlockChunk,
    );
    this.lastBlock = latestBlock;
    if (logs.length === 0) return [];

    const items = await Promise.all(logs.map(async (entry) => {
      const token0 = entry.args.token0?.toLowerCase();
      const token1 = entry.args.token1?.toLowerCase();
      const wbnb = WBNB.toLowerCase();
      if (token0 !== wbnb && token1 !== wbnb) return null;
      const token = token0 === wbnb ? token1 : token0;
      if (!token) return null;
      let creator = null;
      try {
        const tx = await this.publicClient.getTransaction({ hash: entry.transactionHash });
        creator = tx.from.toLowerCase();
      } catch {}
      return {
        address: token,
        symbol: 'PAIR_CREATED',
        name: 'Pancake New Pair',
        creator,
        requestId: '',
        launchTime: 0,
        progress: 0,
        txHash: entry.transactionHash,
        blockNumber: entry.blockNumber ? Number(entry.blockNumber) : 0,
        pair: entry.args.pair?.toLowerCase(),
        token0,
        token1,
        raw: entry.args,
      };
    }));

    return items.filter(Boolean);
  }
}
