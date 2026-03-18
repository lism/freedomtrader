import { createPublicClient, http, pad } from 'viem';
import { bsc } from 'viem/chains';

const client = createPublicClient({
  chain: bsc,
  transport: http('https://bsc.drpc.org')
});

const t = '0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef';
const m1 = pad('0x19e5552a094a93bf3de7c454bef684081a30b139');
const m2 = pad('0x61e1de40854cae288a11feb9b28a064df14d29ef');

async function check() {
  const b = await client.getBlockNumber();
  const logs = await client.getLogs({
    topics: [t, null, [m1, m2]],
    fromBlock: b - 1000n,
    toBlock: b
  });
  console.log(`In the last 1000 blocks, ${logs.length} transfers received.`);
}
check().catch(console.error);
