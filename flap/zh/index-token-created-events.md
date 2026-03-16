# 代币创建事件索引

> Source: https://docs.flap.sh/flap/developers/wallet-and-terminal-and-bot-developers/index-token-created-events.md
> Synced: 2026-03-08
> 本地英文镜像: ../en/index-token-created-events.md

## 用途

指导你构建 Flap 新币索引器：先抓核心创建事件，再补齐可选事件，最终得到可交易所需的完整 token 状态。

## 关键接口与字段

- 必选事件: `TokenCreated`
- 重要可选事件:
  - `TokenCurveSet` / `TokenCurveSetV2`
  - `TokenDexSupplyThreshSet`
  - `TokenQuoteSet`
  - `TokenMigratorSet`
  - `TokenVersionSet`
  - `FlapTokenTaxSet`
  - `TokenExtensionEnabled`
  - `TokenDexPreferenceSet`
- `TokenCreated` 核心字段: `token`, `name`, `symbol`, `meta`, `nonce`

## BSC接入要点

- 以 `TokenCreated` 作为 token 入库触发点。
- 同交易内补抓可选事件；缺失时按文档默认值回填。
- 建议将 `tokenVersion`、`tax`、`curve(r/h/k)`、`dexSupplyThresh` 作为本地缓存主字段，给 `quoteExactInput` / 离线报价复用。

## 常见坑

- 只索引 `TokenCreated`，导致后续报价参数不全。
- 忽略默认值策略，造成老代币解析失败。
- 未按“同交易”关联事件，拿到混乱状态。
