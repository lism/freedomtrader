# Privacy Policy — Freedom Trader

**Last updated:** March 2, 2026

## Overview

Freedom Trader is a browser extension that provides a DeFi trading interface for the BNB Smart Chain (BSC). We are committed to protecting your privacy. This policy explains what data is collected, how it is stored, and how it is used.

## Data Collection

Freedom Trader does **NOT** collect, transmit, or share any personal data with external servers. All data stays on your device.

### What is stored locally

The following data is stored exclusively in your browser's local storage (`chrome.storage.local`):

- **Encrypted wallet private keys** — Private keys are encrypted using AES-GCM-256 with a user-defined password before storage. The password itself is never stored.
- **Password verification hash** — A PBKDF2-derived hash (100,000 iterations, SHA-256) used solely to verify your password locally.
- **Cryptographic salt** — A randomly generated salt used for key derivation, stored locally.
- **User preferences** — RPC URL, slippage settings, gas price, tip rate, and UI customization.

### What is NOT collected

- No analytics or telemetry
- No browsing history
- No personal identifiers (name, email, phone, etc.)
- No wallet addresses or balances sent to any server
- No cookies or tracking pixels

## Data Transmission

Freedom Trader communicates **only** with:

1. **BSC RPC nodes** — To query balances, token info, and submit transactions. The RPC URL is user-configurable. Only blockchain transaction data is transmitted (wallet addresses, transaction parameters).
2. **BNB Smart Chain** — On-chain transactions are broadcast to the public blockchain network.

No data is ever sent to Freedom Trader's developers or any third-party analytics service.

## Encryption & Security

- Private keys are encrypted with **AES-GCM-256** using a key derived via **PBKDF2** (100,000 iterations, SHA-256).
- The encryption key is cached only in the extension's background service worker memory and is never written to disk.
- Auto-lock clears the cached key after a user-configurable timeout (default: 30 minutes).
- The password is never stored — only a derived hash is kept for verification.

## Permissions

| Permission | Purpose |
|---|---|
| `storage` | Store encrypted wallets and user preferences locally |
| `sidePanel` | Display the trading interface in Chrome's side panel |
| `tabs` | Detect contract addresses from supported websites (BSCScan, DEX platforms) to auto-fill the token address field |
| Host permissions (`blockrazor.xyz`, `binance.org`, `bscscan.com`) | Enable automatic contract address detection on these sites |

## Third-Party Services

Freedom Trader does not integrate any third-party analytics, advertising, or tracking services. The only external communication is with user-configured BSC RPC endpoints for blockchain interaction.

## Data Deletion

All data can be deleted by:

1. Removing all wallets in the Settings page, or
2. Uninstalling the extension (all `chrome.storage.local` data is automatically removed by Chrome).

## Open Source

Freedom Trader is open source. You can audit the complete source code at:
https://github.com/dalangdalang934/freedomtrader

## Changes to This Policy

We may update this privacy policy from time to time. Changes will be posted in this document with an updated "Last updated" date.

## Contact

If you have questions about this privacy policy, please open an issue on our GitHub repository:
https://github.com/dalangdalang934/freedomtrader/issues
