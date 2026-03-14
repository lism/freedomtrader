const { spawnSync } = require("node:child_process");

const PROBE_ADDRESSES = [
  "0x000000000000000000000000000000000000dEaD",
  "0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266",
  "0x70997970C51812dc3A010C7d01b50e0d17dc79C8",
  "0x3C44CdDdB6a900fa2b585dd299e03d12FA4293BC",
  "0x90F79bf6EB2c4f870365E785982E1f101E93b906",
  "0x15d34AAf54267DB7D7c367839AAf71A00a2C6A65",
  "0x9965507D1a55bcC2695C58ba16FB37d819B0A4dc",
  "0x976EA74026E726554dB657fA54763abd0C3a0aa9",
  "0x14dC79964da2C08b23698B3D3cc7Ca32193d9955",
  "0x23618e81E3f5cdF7f54C3d65f7FBc0aBf5B21E8f",
  "0xa0Ee7A142d267C1f36714E4a8F75612F20a79720",
  "0xBcd4042DE499D14e55001CcbB24a551F3b954096",
  "0x71bE63f3384f5fb98995898A86B02Fb2426c5788",
  "0xFABB0ac9d68B0B445fB7357272Ff202C5651694a",
  "0x1CBd3b2770909D4e10f157cABC84C7264073C9Ec",
  "0xdF3e18d64BC6A983f673Ab319CCaE4f1a57C7097",
  "0xcd3B766CCDd6AE721141F452C550Ca635964ce71",
  "0x2546BcD3c84621e976D8185a91A922aE77ECEc30",
  "0xbDA5747bFD65F08deb54cb465eB87D40e51B197E",
  "0xdD2FD4581271e230360230F9337D5c0430Bf44C0",
  "0x8626f6940E2eb28930eFb4CeF49B2d1F2C9C1199",
];

const PROBE_STORAGE_TARGETS = [
  { address: "0x444444444444147c48E01D3669260E33d8b33c93", slot: "0x0" },
  { address: "0xF251F83e40a78868FcfA3FA4599Dad6494E46034", slot: "0x0" },
  { address: "0xF251F83e40a78868FcfA3FA4599Dad6494E46034", slot: "0x145" },
];

function normalizeBlockTag(value, latestBlock) {
  if (!value) return latestBlock;
  if (typeof value === "string" && value.startsWith("0x")) {
    return value;
  }

  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < 0) {
    throw new Error(`Invalid BSC_FORK_BLOCK: ${value}`);
  }
  return `0x${parsed.toString(16)}`;
}

function blockTagToDecimalString(blockTag) {
  if (typeof blockTag === "string" && blockTag.startsWith("0x")) {
    return BigInt(blockTag).toString(10);
  }
  return String(blockTag);
}

async function rpcCall(url, method, params) {
  const response = await fetch(url, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      jsonrpc: "2.0",
      id: 1,
      method,
      params,
    }),
  });

  const text = await response.text();
  if (!response.ok) {
    throw new Error(`HTTP ${response.status}: ${text.slice(0, 240)}`);
  }

  let payload;
  try {
    payload = JSON.parse(text);
  } catch (error) {
    throw new Error(`Invalid JSON-RPC response: ${text.slice(0, 240)}`);
  }

  if (payload.error) {
    throw new Error(payload.error.message || JSON.stringify(payload.error));
  }

  return payload.result;
}

async function main() {
  const rpcUrl = process.env.BSC_RPC_URL;
  if (!rpcUrl) {
    console.error("BSC_RPC_URL is required for fork tests.");
    console.error("Use an archive-capable BSC RPC endpoint and retry.");
    process.exit(1);
  }

  const latestBlock = await rpcCall(rpcUrl, "eth_blockNumber", []);
  const probeBlock = normalizeBlockTag(process.env.BSC_FORK_BLOCK, latestBlock);

  try {
    for (const probeAddress of PROBE_ADDRESSES) {
      await rpcCall(rpcUrl, "eth_getCode", [probeAddress, probeBlock]);
      await rpcCall(rpcUrl, "eth_getTransactionCount", [probeAddress, probeBlock]);
      await rpcCall(rpcUrl, "eth_getBalance", [probeAddress, probeBlock]);
    }
    for (const target of PROBE_STORAGE_TARGETS) {
      await rpcCall(rpcUrl, "eth_getStorageAt", [target.address, target.slot, probeBlock]);
    }
  } catch (error) {
    console.error("Fork RPC preflight failed.");
    console.error(`RPC: ${rpcUrl}`);
    console.error(`Block: ${probeBlock}`);
    console.error(`Reason: ${error.message}`);
    console.error("The endpoint must support archive-style historical state queries such as eth_getCode/eth_getTransactionCount/eth_getBalance with a blockTag.");
    process.exit(1);
  }

  const childEnv = {
    ...process.env,
    BSC_FORK_BLOCK: process.env.BSC_FORK_BLOCK || blockTagToDecimalString(probeBlock),
  };

  const child = spawnSync("npx", ["hardhat", "test", "test/LimitOrderBook.fork.test.js"], {
    stdio: "inherit",
    env: childEnv,
  });

  process.exit(child.status ?? 1);
}

main().catch((error) => {
  console.error(error.message || error);
  process.exit(1);
});
