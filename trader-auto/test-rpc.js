import { createPublicClient, http, parseAbiItem } from 'viem';
import { bsc } from 'viem/chains';

const publicClient = createPublicClient({
  chain: bsc,
  transport: http('https://bsc.drpc.org'),
});

const PAIR_CREATED_EVENT = parseAbiItem(
  'event PairCreated(address indexed token0, address indexed token1, address pair, uint256)'
);

async function check() {
  const currentBlock = await publicClient.getBlockNumber();
  console.log('Current block:', currentBlock);
  const logs = await publicClient.getLogs({
    address: '0xcA143Ce32Fe78f1f7019d7d551a6402fC5350c73', // PANCAKE_FACTORY
    event: PAIR_CREATED_EVENT,
    fromBlock: currentBlock - 5000n,
    toBlock: currentBlock,
  });
  console.log(`Found ${logs.length} new PancakeSwap pairs in the last 5000 blocks (~4 hours).`);
}

check().catch(console.error);
