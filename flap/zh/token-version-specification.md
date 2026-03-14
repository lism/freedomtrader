# TokenVersion 规范

> Source: https://docs.flap.sh/flap/developers/wallet-and-terminal-and-bot-developers/token-version-specification.md
> Synced: 2026-03-08
> 本地英文镜像: ../en/token-version-specification.md

## 用途

定义 token 实现版本枚举，用于决定你在交易、税币、permit、展示层应启用哪些能力。

## 关键接口与字段

- 枚举值:
  - `0/1`: `TOKEN_LEGACY_MINT_NO_PERMIT`（历史兼容）
  - `2`: `TOKEN_V2_PERMIT`
  - `3`: `TOKEN_GOPLUS`
  - `4`: `TOKEN_TAXED`
  - `5`: `TOKEN_TAXED_V2`
- 获取方式:
  - 事件: `TokenVersionSet(token, version)`
  - 读方法: `getTokenV5/V6/V7` 中的 `tokenVersion`

## BSC接入要点

- 建议在 token 首次发现时落库 `tokenVersion`，交易前无需重复推断。
- `TOKEN_TAXED` / `TOKEN_TAXED_V2` 需走税币解析与报价分支。
- 有 `permit` 能力的版本可优先启用 `permitData`，减少授权交易。

## 常见坑

- 把 0 和 1 当两种不同实现处理。
- 用固定逻辑处理所有版本，遗漏税币/permit特性。
- 不监听 `TokenVersionSet`，版本变更后缓存过期。
