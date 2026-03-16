// Freedom Trader 本地系统 - 全局状态
// 与 Chrome 扩展的 state.js 对齐，去掉了 DOM 相关状态

export const state = {
  config: {},
  tradeMode: 'buy',
  currentChain: 'bsc',

  // shared — 当前链的 token/LP 信息
  tokenInfo: { decimals: 18, symbol: '', balance: 0n },
  lpInfo: { hasLP: false, isInternal: false, reserveBNB: 0n, reserveToken: 0n },
  tokenBalances: new Map(),

  // BSC
  publicClient: null,
  wallets: [],
  activeWalletIds: [],
  walletClients: new Map(),   // id -> { client, account }
  walletBalances: new Map(),
  approvedTokens: new Set(),

  // SOL
  solConfig: { slippage: 25, buyAmount: 0.1, priorityFee: 100000, jitoTip: 100000, rpcUrl: '' },
  solWallets: [],
  solActiveWalletIds: [],
  solAddresses: new Map(),
  solKeypairs: new Map(),     // id -> Keypair (本地直接持有)
  solWalletBalances: new Map(),
};
