# Inspect A Tax Token

> Source: https://docs.flap.sh/flap/developers/wallet-and-terminal-and-bot-developers/inspect-a-tax-token.md
> Synced: 2026-03-08
> Snapshot: official GitBook markdown export


## Overview

You can get the tax info of any tax token using the Tax Token Helper contract. Our website uses this contract to get tax info for tokens and show them to users:

<figure><img src="https://2671086575-files.gitbook.io/~/files/v0/b/gitbook-x-prod.appspot.com/o/spaces%2F5KujUBwRoHVjn8OZEgtZ%2Fuploads%2FeCNDbbhq7lDU8jAkw7bm%2Fimage.png?alt=media&#x26;token=82717aa1-3278-4d91-af71-31670a9c92d7" alt="" width="563"><figcaption></figcaption></figure>

## Tax Token Helper

| Chain       | Tax Token Helper                           |
| ----------- | ------------------------------------------ |
| BNB Mainnet | 0x53841c73217735F37BC1775538b03b23feFD8346 |
| BNB Testnet | 0xD64441e5FcD02D342B8cf6eBA10Ef6E40d0dA90f |

```solidity
// SPDX-License-Identifier: MIT
pragma solidity =0.8.24;

/// @title ITaxTokenHelper
/// @notice Interface for the TaxTokenHelper contract that provides utilities for interacting with tax tokens
/// @dev This helper supports both legacy (TOKEN_TAXED) and new (TOKEN_TAXED_V2) tax token versions
interface ITaxTokenHelper {
    /// @notice Structure containing comprehensive tax token configuration and statistics
    /// @dev All BPS values are in basis points (1 BPS = 0.01%)
    struct TaxTokenInfo {
        /// @notice Marketing tax allocation in basis points (0-10000)
        uint16 marketBps;
        
        /// @notice Deflation (burn) tax allocation in basis points (0-10000)
        uint16 deflationBps;
        
        /// @notice Liquidity provision tax allocation in basis points (0-10000)
        uint16 lpBps;
        
        /// @notice Dividend distribution tax allocation in basis points (0-10000)
        uint16 dividendBps;
        
        /// @notice Total tax rate applied to transfers in basis points (sum of all allocations)
        uint16 taxRate;
        
        /// @notice Cumulative amount of tokens burnt (sent to black hole and dead addresses)
        uint256 burntTokenAmount;
        
        /// @notice Cumulative amount of quote tokens distributed to dividend holders
        uint256 totalQuoteSentToDividend;
        
        /// @notice Cumulative amount of quote tokens added to liquidity pools
        uint256 totalQuoteAddedToLiquidity;
        
        /// @notice Cumulative amount of tax tokens added to liquidity pools
        uint256 totalTokenAddedToLiquidity;
        
        /// @notice Cumulative amount of quote tokens sent to marketing wallet
        uint256 totalQuoteSentToMarketing;
        
        /// @notice Address receiving marketing tax allocations
        address marketingWallet;
        
        /// @notice Address of the quote token used for tax swaps (address(0) for native token)
        address quoteToken;
        
        /// @notice Minimum token balance required to receive dividend distributions
        uint256 minimumShareBalance;
    }

    /// @notice Returns the version of the TaxTokenHelper contract
    /// @return Version string in semantic versioning format
    function version() external pure returns (string memory);

    /// @notice Retrieves comprehensive information about a tax token's configuration and statistics
    /// @dev Returns zero/empty values for non-tax tokens (TOKEN_V2_PERMIT)
    /// @dev For legacy TOKEN_TAXED tokens, only marketBps, taxRate, marketingWallet, quoteToken, and totalQuoteSentToMarketing are populated
    /// @dev For TOKEN_TAXED_V2 tokens, all fields are populated based on TaxProcessor state
    /// @param taxToken Address of the tax token to query
    /// @return info TaxTokenInfo struct containing all tax token configuration and statistics
    function getTaxTokenInfo(address taxToken) external view returns (TaxTokenInfo memory info);

    /// @notice Retrieves dividend information for a specific user and tax token
    /// @dev Returns (0, 0) if the tax token has no dividend contract configured
    /// @param taxToken Address of the tax token
    /// @param user Address of the user to query dividend information for
    /// @return claimed Total amount of dividends already claimed by the user
    /// @return pending Amount of dividends currently available for withdrawal
    function getDividendInfo(address taxToken, address user) external view returns (uint256 claimed, uint256 pending);

    /// @notice Claims accumulated dividends for the caller (msg.sender)
    /// @dev Reverts if the tax token has no dividend contract configured
    /// @dev For WETH dividends, automatically unwraps to native token
    /// @param taxToken Address of the tax token to claim dividends from
    function claimDividend(address taxToken) external;

    /// @notice Claims accumulated dividends for the caller with optional native token unwrapping
    /// @dev Reverts if the tax token has no dividend contract configured
    /// @param taxToken Address of the tax token to claim dividends from
    /// @param unwrapWETH If true, unwraps WETH dividends to native token; if false, sends WETH
    function claimDividend(address taxToken, bool unwrapWETH) external;

    /// @notice Claims accumulated dividends on behalf of a specified user
    /// @dev Reverts if the tax token has no dividend contract configured
    /// @dev Can be called by anyone to trigger dividend withdrawal for any user
    /// @param taxToken Address of the tax token to claim dividends from
    /// @param unwrapWETH If true, unwraps WETH dividends to native token; if false, sends WETH
    /// @param user Address of the user to claim dividends for
    function claimDividendForUser(address taxToken, bool unwrapWETH, address user) external;
}
```

We can get all the tax info in the previous illustration by calling `getTaxTokenInfo` function of the `TaxTokenHelper` contract. It returns a `TaxTokenInfo` struct that contains all the relevant tax configuration and statistics for a given tax token.

Note that for V1 Tax token, the mktBps is `10000` (i.e 100% goes to the marketing wallet, or funds recipient wallet). The returned `totalQuoteSentToMarketing` field may be zero for old V1 Tax tokens. If you found that to be the case, we provide a backend to get the `totalQuoteSentToMarketing` for V1 Tax tokens:

```
https://t3w1p53k7a.execute-api.eu-west-3.amazonaws.com/donation?token=0x36F2FD027F5f27C59B8C6d64dF64bcC8E8C97777 
```

> Note: you only need this fallback when `totalQuoteSentToMarketing` returned by `getTaxTokenInfo` is zero for V1 Tax tokens. For V2 Tax tokens, the `totalQuoteSentToMarketing` is always accurate.

## how to inspect a tax token's vault

For a tax token, you can also inspect its vault via VaultPortal, which is the registry for vaults (see [developers/vault-developers/flap-tax-vault.md](https://docs.flap.sh/flap/developers/vault-developers/flap-tax-vault)). Use the VaultPortal `tryGetVault` method to get basic vault information, and the returned `description` gives a human-readable summary of the vault. For details on the fields returned by `tryGetVault`, refer to [Get Vault Info](https://docs.flap.sh/flap/vault-developers/flap-tax-vault#get-vault-info).

If you want deeper, vault-type-specific data, compare the `vaultFactory` returned by `tryGetVault` against the known registered vault factories and then query the vault using its own interface. The list of registered vault factories and their interfaces is available at [developers/token-launcher-developers/registered-vaults.md](https://docs.flap.sh/flap/developers/token-launcher-developers/registered-vaults).
