export const state = {
  config: {},
  tradeMode: 'buy',
  currentChain: 'bsc',
  amountDrafts: {
    bsc: { buy: '', sell: '' },
    sol: { buy: '', sell: '' },
  },

  // shared — current chain's token/LP info (written by token-bsc or token-sol)
  tokenInfo: { decimals: 18, symbol: '', balance: 0n },
  lpInfo: { hasLP: false, isInternal: false, routeSource: 0 },
  tokenBalances: new Map(),

  // BSC
  publicClient: null,
  v4PublicClient: null,
  wallets: [],
  activeWalletIds: [],
  walletClients: new Map(),
  walletBalances: new Map(),
  approvedTokens: new Set(),
  quoteToken: { symbol: 'BNB', address: '0xEeeeeEeeeEeEeeEeEeEeeEEEeeeeEeeeeeeeEEeE', decimals: 18 },
  quoteBalances: new Map(),

  // SOL
  solConfig: { slippage: 25, buyAmount: 0.1, priorityFee: 100000, jitoTip: 100000, rpcUrl: '' },
  solWallets: [],
  solActiveWalletIds: [],
  solAddresses: new Map(),
  solWalletBalances: new Map(),
};
