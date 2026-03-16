# Inspect Token（状态查询）

> Source: https://docs.flap.sh/flap/developers/wallet-and-terminal-and-bot-developers/inspect-a-token.md
> Synced: 2026-03-08
> 本地英文镜像: ../en/inspect-a-token.md

## 用途

统一查询单个 token 的协议状态，为“是否可交易、如何报价、走哪条交易路径”提供输入。

## 关键接口与字段

- 推荐接口: `getTokenV7(token)`（新接入默认优先）
- 历史兼容: `getTokenV2` ~ `getTokenV6`
- 常用字段:
  - `status`
  - `reserve`
  - `circulatingSupply`
  - `price`
  - `tokenVersion`
  - `r/h/k`
  - `dexSupplyThresh`
  - `quoteTokenAddress`
  - `nativeToQuoteSwapEnabled`
  - `taxRate`
  - `pool`
  - `progress`
  - `lpFeeProfile`
  - `dexId`

## BSC接入要点

- 你的 BSC 版本建议以 `getTokenV7` 为主，失败时可按需回退到 `getTokenV6/V5`。
- `quoteTokenAddress` + `nativeToQuoteSwapEnabled` 决定买入时是否可直接用 BNB。
- `status` 与 `pool` 用于区分 bonding curve 与 DEX 阶段。

## 常见坑

- 默认所有链都支持 V7（文档明确不同链支持进度不同）。
- 忽略 `tokenVersion`，导致 tax/permit 分支错误。
- 仅靠 `price` 下单，不结合 `quoteExactInput` 做实时校验。
