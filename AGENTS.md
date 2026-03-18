---
description: 
alwaysApply: true
---

# Freedom Trader — Agent Instructions

## Development Log (MANDATORY)

**Every coding session MUST update `DEVLOG.md` at the project root.**

- **Session start**: Read `DEVLOG.md` to understand recent context
- **Session end**: Append a session entry summarizing changes, decisions, and next steps
- If `DEVLOG.md` doesn't exist, create it
- Never overwrite existing entries — always append
- Use the `dev-docs` skill for entry format and templates

This is non-negotiable. No commit should happen without a corresponding DEVLOG entry.

## Code Change Standards

When making code changes in this project:

1. **Read before edit** — Always read the file and understand its context before modifying
2. **Preserve architecture** — Follow the existing module structure (see README.md for architecture)
3. **Chain awareness** — This is a dual-chain (BSC + Solana) project; changes may affect both chains
4. **Test in context** — Verify builds pass: `cd trader-extension && npm run build`
5. **Security first** — Never log or expose private keys, mnemonics, or sensitive wallet data

## Project Overview

This is a **BSC + Solana dual-chain trading terminal** implemented as a Chrome Side Panel extension.

- **FreedomRouter/** — Solidity smart contracts (Hardhat, Solidity 0.8.22)
- **trader-extension/** — Chrome Extension Manifest V3 (viem + @solana/web3.js)

---

## Build / Lint / Test Commands

### FreedomRouter (Smart Contracts)

```bash
cd FreedomRouter
npm install                              # Install dependencies
npx hardhat compile                     # Compile contracts
npx hardhat test                         # Run Hardhat tests
npx hardhat run scripts/test.js --network bsc  # Trade testing
```

**Environment variables** (create `.env` in FreedomRouter/):
```
PRIVATE_KEY=0x...           # Deployer private key
ROUTER_ADDRESS=0x...        # Router proxy address
TOKEN_ADDRESS=0x...        # Token to test
CMD=info|buy|sell|test     # Command: info/query, buy, sell, or full test
TIP=0                      # Tip rate: 0=free, 10=0.1%, 100=1%
AMOUNT=0.0001              # Buy amount in BNB
SELL_PCT=10                # Sell percentage of balance
```

### trader-extension (Chrome Extension)

```bash
cd trader-extension
npm install              # Install dependencies
npm run build           # Build to dist/ (esbuild)
npm run clean           # Clean dist/
```

Load `dist/` folder into Chrome at `chrome://extensions/` (Developer Mode → Load unpacked).

---

## Code Style Guidelines

### General

- **Language**: JavaScript (ES Modules with `.js` extension)
- **No formal linter/formatter** — follow existing patterns in codebase
- **Comments**: Chinese comments used extensively (e.g., `// 买入`, `// 授权`)
- **Console logging**: Use `[TAG]` format (e.g., `[BUY]`, `[SELL]`, `[APPROVE]`)

### JavaScript (trader-extension)

**Imports**:
```javascript
import { parseUnits } from 'viem';
import { FREEDOM_ROUTER, ROUTER_ABI } from './constants.js';
import { state } from './state.js';
```

- Use named imports from modules
- Use `.js` extension in local imports
- Uppercase for constants (e.g., `MAX_UINT256`, `ZERO_ADDR`)

**Naming**:
- `camelCase` for functions and variables: `getSellApproveTarget()`, `approvalInFlight`
- `SCREAMING_SNAKE` for constants: `MAX_UINT256`, `DEFAULT_TIP_RATE`
- Prefix private functions with underscore: `_isFourInternal()`, `_getQuoteBuy()`

**Functions**:
- Use `async/await` for all async operations
- Named exports for public API: `export async function buy(...)`
- Error messages in Chinese: `throw new Error('钱包未初始化')`

**Error Handling**:
- Always use `try/catch` with meaningful error messages
- Re-throw with context: `throw new Error('无法预估买入数量: ' + e.message)`

**State Management**:
- Use module-level `Map` for caching: `const approvalInFlight = new Map()`
- State stored in `state.js` module pattern

### Solidity (FreedomRouter)

**Version**: `pragma solidity ^0.8.22;`

**Style**:
- Contract name: `CamelCase` (e.g., `FreedomRouterImpl`)
- Functions: `camelCase`
- Events: `CamelCase` with `event` keyword
- Variables: `camelCase` for storage, `CamelCase` for structs
- Constants: `CamelCase` for contract constants (e.g., `WBNB`)

**Layout**:
```solidity
// SPDX-License-Identifier: MIT
pragma solidity ^0.8.22;

import "@openzeppelin/...";

/**
 * @title ContractName
 * @notice Description
 */
contract ContractName {
    // Constants
    address public constant WBNB = 0x...;

    // Storage
    address public tokenManagerV1;

    // Events
    event Swap(...);

    // Constructor
    constructor() { ... }

    // External functions
    function externalFunc() external { ... }

    // Internal functions
    function _internalFunc() internal { ... }
}
```

**Interfaces**: Define at bottom of file with `interface` keyword

---

## Architecture Patterns

### Chrome Extension Structure

```
trader-extension/
├── background.js       # Service Worker: URL detection, key caching
├── manifest.json       # Extension manifest V3
├── src/
│   ├── trader.js       # Main trade logic entry
│   ├── trading.js      # BSC trading (FreedomRouter)
│   ├── sol-trading.js  # Solana trading wrapper
│   ├── wallet.js       # Wallet router
│   ├── wallet-bsc.js   # BSC wallet (viem)
│   ├── wallet-sol.js   # SOL wallet (@solana/web3.js)
│   ├── token.js       # Token detection router
│   ├── token-bsc.js   # BSC token (Four/Flap/Pancake)
│   ├── token-sol.js   # SOL token (Pump.fun/PumpSwap)
│   ├── batch.js       # Multi-wallet batch trading
│   ├── state.js       # Global state (Chrome storage)
│   ├── lock.js        # AES-GCM encryption
│   ├── crypto.js      # Crypto proxy to background
│   ├── ui.js          # UI logic
│   ├── theme.js       # Dark mode
│   └── sol/           # Solana core modules
│       ├── trading.js
│       ├── bonding-curve.js
│       ├── pump-swap.js
│       ├── connection.js
│       └── ...
└── dist/               # Build output
```

### BSC Chain Interaction

- Use `viem` for all BSC interactions
- `publicClient` for reads, `walletClient` for writes
- Always include `gas` and `gasPrice` estimates
- Use contract ABIs defined in `constants.js`

### Security Patterns

- **Private keys**: Never stored in plaintext; encrypted with AES-256-GCM
- **Keys derived from password**: PBKDF2 (100k rounds) → AES-256-GCM
- **Deadline on BSC transactions**: Always include deadline (10 seconds)
- **Approval targets**: Use contract-returned `approveTarget`, never guess
- **No private key transmission**: All signing happens in background service worker

---

## Key Contract Addresses (BSC Mainnet)

| Contract | Address |
|----------|---------|
| FreedomRouter (Proxy) | `0x444444444444147c48E01D3669260E33d8b33c93` |
| FreedomRouterImpl | `0xc7B76F939CbC84d7a7077411974A5CbC9dfb3Bbd` |
| TokenManager V2 | `0x5c952063c7fc8610FFDB798152D69F0B9550762b` |
| TokenManagerHelper3 | `0xF251F83e40a78868FcfA3FA4599Dad6494E46034` |
| Flap Portal | `0xe2cE6ab80874Fa9Fa2aAE65D277Dd6B8e65C9De0` |

---

## Testing Guidelines

### Manual Testing (FreedomRouter)

1. Configure `.env` with `PRIVATE_KEY`, `ROUTER_ADDRESS`, `TOKEN_ADDRESS`
2. Run: `npx hardhat run scripts/test.js --network bsc`
3. Set `CMD=info` to query token info
4. Set `CMD=test` for full buy + 50% sell cycle

### Extension Testing

1. Build: `npm run build` in trader-extension/
2. Load unpacked extension in Chrome
3. Open DevTools → Extensions → Service Worker for debugging
4. Use console logs with `[TAG]` prefix to trace execution

---

## Common Patterns

### Contract Read
```javascript
const result = await state.publicClient.readContract({
  address: CONTRACT_ADDR,
  abi: CONTRACT_ABI,
  functionName: 'functionName',
  args: [arg1, arg2]
});
```

### Contract Write
```javascript
const res = await bscWriteContract(walletId, {
  address: CONTRACT_ADDR,
  abi: CONTRACT_ABI,
  functionName: 'functionName',
  args: [arg1, arg2],
  value: parseEther("0.1"),  // optional
  gas: 800000n,
  gasPrice: parseUnits(gasPrice.toString(), 9)
});
```

### Waiting for Receipt
```javascript
const receipt = await state.publicClient.waitForTransactionReceipt({
  hash: txHash,
  timeout: 120000  // 2 minutes
});
if (receipt.status !== 'success') throw new Error('Transaction failed');
```

---

## Important Notes

1. **No test files** in FreedomRouter — testing is manual via scripts/test.js
2. **No ESLint/Prettier config** — informal coding style
3. **Chinese comments throughout** — maintain consistency with existing code
4. **Always use BigInt** for blockchain values (`BigInt("123")` or `123n`)
5. **Timeout on RPC calls** — always set reasonable timeouts (120s forconfirmations)
```
