import { sleep } from './utils.js';
import { toEventHash, decodeEventLog } from 'viem';

export async function scanLogsInChunks(publicClient, params, fromBlock, toBlock, initialChunk = 1) {
  const logs = [];
  let cursor = fromBlock;
  let chunk = BigInt(initialChunk);

  while (cursor <= toBlock) {
    const endBlock = cursor + chunk - 1n > toBlock ? toBlock : cursor + chunk - 1n;
    try {
      let rpcParams = {
        address: params.address,
        fromBlock: `0x${cursor.toString(16)}`,
        toBlock: `0x${endBlock.toString(16)}`,
      };
      if (params.rawTopics) {
        rpcParams.topics = params.rawTopics;
      } else if (params.event) {
        rpcParams.topics = [toEventHash(params.event)];
      }
      
      const part = await publicClient.request({
        method: 'eth_getLogs',
        params: [rpcParams]
      });
      if (params.event) {
        logs.push(...part.map(log => {
          try {
            const decoded = decodeEventLog({ abi: [params.event], data: log.data, topics: log.topics });
            return { ...log, args: decoded.args, eventName: decoded.eventName };
          } catch {
            return log;
          }
        }));
      } else {
        logs.push(...part);
      }
      cursor = endBlock + 1n;
    } catch (error) {
      const message = String(error?.message || error).toLowerCase();
      if (message.includes('limit') || message.includes('exceed') || message.includes('too many requests')) {
        if (chunk > 1n) {
          chunk = chunk > 2n ? chunk / 2n : 1n;
        } else {
          console.warn('[RPC WARN] 请求频繁被限流，等待 2 秒后继续...');
          await sleep(2000);
        }
        continue;
      }
      throw error;
    }
  }

  return logs;
}
