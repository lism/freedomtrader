# Flap BSC Docs Snapshot

> Snapshot date: 2026-03-08
> Scope: Wallet/Terminal/Bot Developers - BSC 核心交易集（7 页）
> Format: `en` 官方镜像 + `zh` 结构化整理

## 目录结构

- `en/`：英文原文镜像（保留代码块与原始结构）
- `zh/`：中文整理版（用途 / 关键接口与字段 / BSC接入要点 / 常见坑）
- `assets/`：关键 ABI/JSON 本地化资源

## 页面映射

| 主题 | 英文镜像 | 中文整理 | 官方来源 |
| --- | --- | --- | --- |
| Deployed Contract Addresses | `en/deployed-contract-addresses.md` | `zh/deployed-contract-addresses.md` | https://docs.flap.sh/flap/developers/wallet-and-terminal-and-bot-developers/deployed-contract-addresses.md |
| Index Token Created Events | `en/index-token-created-events.md` | `zh/index-token-created-events.md` | https://docs.flap.sh/flap/developers/wallet-and-terminal-and-bot-developers/index-token-created-events.md |
| Bonding Curve In Developers' Perspective | `en/bonding-curve-in-developers-perspective.md` | `zh/bonding-curve-in-developers-perspective.md` | https://docs.flap.sh/flap/developers/wallet-and-terminal-and-bot-developers/bonding-curve-in-developers-perspective.md |
| Inspect A Token | `en/inspect-a-token.md` | `zh/inspect-a-token.md` | https://docs.flap.sh/flap/developers/wallet-and-terminal-and-bot-developers/inspect-a-token.md |
| Inspect A Tax Token | `en/inspect-a-tax-token.md` | `zh/inspect-a-tax-token.md` | https://docs.flap.sh/flap/developers/wallet-and-terminal-and-bot-developers/inspect-a-tax-token.md |
| Trade Tokens | `en/trade-tokens.md` | `zh/trade-tokens.md` | https://docs.flap.sh/flap/developers/wallet-and-terminal-and-bot-developers/trade-tokens.md |
| Token Version Specification | `en/token-version-specification.md` | `zh/token-version-specification.md` | https://docs.flap.sh/flap/developers/wallet-and-terminal-and-bot-developers/token-version-specification.md |

## ABI 资产

- `assets/deployed-contract-addresses__portal-abi.json`
  - Source: https://2671086575-files.gitbook.io/~/files/v0/b/gitbook-x-prod.appspot.com/o/spaces%2F5KujUBwRoHVjn8OZEgtZ%2Fuploads%2FOz9Mh8mZBLCrBME9TwAB%2Fabi.json?alt=media&token=13f5f768-e976-463b-bef7-3b10cfaf1ea3

## BSC 适配阅读顺序（推荐）

1. `zh/deployed-contract-addresses.md` + `zh/token-version-specification.md`（先锁定地址与版本兼容策略）
2. `zh/inspect-a-token.md` + `zh/inspect-a-tax-token.md`（明确状态与税币分支）
3. `zh/trade-tokens.md`（接入 `quoteExactInput` / `swapExactInput`）
4. `zh/index-token-created-events.md` + `zh/bonding-curve-in-developers-perspective.md`（补齐索引与离线报价）

## 说明

- 本次为一次性快照，不包含自动同步脚本。
- 图片等非关键二进制资源保留外链，未做本地镜像。
