export const DEFAULT_TIP_RATE = 0;
export const DEFAULT_RPC = 'https://bsc-dataseed.bnbchain.org';

export const BSC_RPCS = [
  'https://bsc-dataseed.bnbchain.org',
  'https://bsc-dataseed1.bnbchain.org',
  'https://bsc-dataseed2.bnbchain.org',
  'https://bsc-dataseed3.bnbchain.org',
  'https://bsc-dataseed4.bnbchain.org',
  'https://bsc.publicnode.com',
  'https://bsc-dataseed1.defibit.io',
  'https://bsc-dataseed1.ninicoin.io',
];

export const FREEDOM_ROUTER = '0xCd4D70bb991289b5A8522adB93Cd3C4b93B4Dceb';
export const TOKEN_MANAGER_V2 = '0x5c952063c7fc8610FFDB798152D69F0B9550762b';
export const HELPER3 = '0xF251F83e40a78868FcfA3FA4599Dad6494E46034';
export const FLAP_PORTAL = '0xe2cE6ab80874Fa9Fa2aAE65D277Dd6B8e65C9De0';
export const WBNB = '0xbb4CdB9CBd36B01bD1cBaEBF2De08d9173bc095c';
export const ZERO_ADDR = '0x0000000000000000000000000000000000000000';

// RouteSource 枚举（与合约 v6.3 对齐）
export const ROUTE = {
  NONE: 0,
  FOUR_INTERNAL_BNB: 1,
  FOUR_INTERNAL_ERC20: 2,
  FOUR_EXTERNAL: 3,
  FLAP_BONDING: 4,
  FLAP_BONDING_SELL: 5,  // ERC20 quote + nativeSwap disabled: sell via Portal, buy via PancakeSwap
  FLAP_DEX: 6,
  PANCAKE_ONLY: 7,
};

export const HELPER3_ABI = [
  {
    name: 'tryBuy', type: 'function', stateMutability: 'view',
    inputs: [{ name: 'token', type: 'address' }, { name: 'amount', type: 'uint256' }, { name: 'funds', type: 'uint256' }],
    outputs: [
      { name: 'tokenManager', type: 'address' }, { name: 'quote', type: 'address' },
      { name: 'estimatedAmount', type: 'uint256' }, { name: 'estimatedCost', type: 'uint256' },
      { name: 'estimatedFee', type: 'uint256' }, { name: 'amountMsgValue', type: 'uint256' },
      { name: 'amountApproval', type: 'uint256' }, { name: 'amountFunds', type: 'uint256' }
    ]
  },
  {
    name: 'trySell', type: 'function', stateMutability: 'view',
    inputs: [{ name: 'token', type: 'address' }, { name: 'amount', type: 'uint256' }],
    outputs: [
      { name: 'tokenManager', type: 'address' }, { name: 'quote', type: 'address' },
      { name: 'funds', type: 'uint256' }, { name: 'fee', type: 'uint256' }
    ]
  },
];

export const ERC20_ABI = [
  { name: 'balanceOf', type: 'function', stateMutability: 'view', inputs: [{ name: 'account', type: 'address' }], outputs: [{ type: 'uint256' }] },
  { name: 'decimals', type: 'function', stateMutability: 'view', inputs: [], outputs: [{ type: 'uint8' }] },
  { name: 'symbol', type: 'function', stateMutability: 'view', inputs: [], outputs: [{ type: 'string' }] },
  { name: 'approve', type: 'function', stateMutability: 'nonpayable', inputs: [{ name: 'spender', type: 'address' }, { name: 'amount', type: 'uint256' }], outputs: [{ type: 'bool' }] },
  { name: 'allowance', type: 'function', stateMutability: 'view', inputs: [{ name: 'owner', type: 'address' }, { name: 'spender', type: 'address' }], outputs: [{ type: 'uint256' }] },
];

export const ETH_SENTINEL = '0xEeeeeEeeeEeEeeEeEeEeeEEEeeeeEeeeeeeeEEeE';
export const USDC = '0x8AC76a51cc950d9822D68b83fE1Ad97B32Cd580d';
export const USDT = '0x55d398326f99059fF775485246999027B3197955';
export const QUOTE_TOKENS = [
  { symbol: 'BNB',  address: ETH_SENTINEL, decimals: 18 },
  { symbol: 'USDT', address: USDT, decimals: 18 },
  { symbol: 'USDC', address: USDC, decimals: 18 },
];

export const ROUTER_ABI = [
  {
    name: 'trade', type: 'function', stateMutability: 'payable',
    inputs: [
      { name: 'tokenIn', type: 'address' }, { name: 'tokenOut', type: 'address' },
      { name: 'amountIn', type: 'uint256' }, { name: 'amountOutMin', type: 'uint256' },
      { name: 'tipRate', type: 'uint256' }, { name: 'deadline', type: 'uint256' }
    ],
    outputs: [{ name: 'amountOut', type: 'uint256' }]
  },
  {
    name: 'quote', type: 'function', stateMutability: 'nonpayable',
    inputs: [
      { name: 'tokenIn', type: 'address' }, { name: 'amountIn', type: 'uint256' },
      { name: 'tokenOut', type: 'address' }
    ],
    outputs: [{ type: 'uint256' }]
  },
  {
    name: 'getTokenInfo', type: 'function', stateMutability: 'view',
    inputs: [{ name: 'token', type: 'address' }],
    outputs: [{
      name: 'info', type: 'tuple',
      components: [
        { name: 'routeSource', type: 'uint8' }, { name: 'approveTarget', type: 'address' },
        { name: 'isInternal', type: 'bool' }, { name: 'tmFunds', type: 'uint256' },
        { name: 'tmMaxFunds', type: 'uint256' }, { name: 'tmOffers', type: 'uint256' },
        { name: 'flapStatus', type: 'uint8' }
      ]
    }]
  },
];
