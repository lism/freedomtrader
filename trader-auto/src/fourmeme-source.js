import { parseAbiItem, decodeEventLog } from 'viem';
import { log } from './logger.js';
import { scanLogsInChunks } from './log-scanner.js';

const TOKEN_CREATE_EVENT = parseAbiItem(
  'event TokenCreate(address creator, address token, uint256 requestId, string name, string symbol, uint256 totalSupply, uint256 launchTime)'
);
const TOPIC_V1 = '0xc60523754e4c8d044ae75f841c3a7f27fefeed24c086155510c2ae0edf538fa0';
const TOPIC_V2 = '0x7db52723a3b2cdd6164364b3b766e65e540d7be48ffa89582956d8eaebe62942'; // new gas-optimized event

export class FourMemeSource {
  constructor(config, publicClient) {
    this.config = config;
    this.publicClient = publicClient;
    this.lastBlock = null;
  }

  async poll() {
    const latestBlock = await this.publicClient.getBlockNumber();
    if (this.lastBlock == null) {
      this.lastBlock = this.config.startBlock ?? (latestBlock > 3n ? latestBlock - 3n : latestBlock);
      log('AUTO', `Four.meme 监听起始块: ${this.lastBlock.toString()}`);
      return [];
    }

    const fromBlock = this.lastBlock + 1n;
    if (fromBlock > latestBlock) return [];

    const [logsV1, logsV2] = await Promise.all([
      scanLogsInChunks(
        this.publicClient,
        {
          address: this.config.tokenManager,
          rawTopics: [TOPIC_V1],
        },
        fromBlock,
        latestBlock,
        this.config.logBlockChunk,
      ),
      scanLogsInChunks(
        this.publicClient,
        {
          address: this.config.tokenManager,
          rawTopics: [TOPIC_V2],
        },
        fromBlock,
        latestBlock,
        this.config.logBlockChunk,
      ),
    ]);
    const logs = [...logsV1, ...logsV2];
    this.lastBlock = latestBlock;
    if (logs.length === 0) return [];

    return logs.map((entry) => {
      const topic0 = entry.topics[0];
      let tokenAddress, creator, symbol, name, progress;

      if (topic0 === TOPIC_V2) {
        // New ABI: V2 event uses no strings. Word 0=token, Word 1=creator
        const data = entry.data || '';
        tokenAddress = '0x' + data.slice(26, 66);
        creator = '0x' + data.slice(90, 130);
        symbol = 'UNKNOWN';
        name = '';
        progress = 0;
      } else {
        // V1 event
        try {
          const decoded = decodeEventLog({ abi: [TOKEN_CREATE_EVENT], data: entry.data, topics: entry.topics });
          tokenAddress = decoded.args.token;
          creator = decoded.args.creator;
          symbol = decoded.args.symbol;
          name = decoded.args.name;
        } catch {
          // fallback if decodeEventLog fails on V1 signature
          tokenAddress = entry.topics[2] ? '0x' + entry.topics[2].slice(26) : '';
          creator = entry.topics[1] ? '0x' + entry.topics[1].slice(26) : '';
        }
        progress = 0;
      }

      return {
        address: (tokenAddress || '').toLowerCase(),
        symbol: symbol || 'UNKNOWN',
        name: name || '',
        creator: (creator || '').toLowerCase(),
        requestId: '',
        launchTime: 0,
        progress: progress,
        txHash: entry.transactionHash,
        blockNumber: entry.blockNumber ? Number(BigInt(entry.blockNumber)) : 0,
        raw: entry.data,
      };
    }).filter(x => x.address && x.address !== '0x');
  }
}
