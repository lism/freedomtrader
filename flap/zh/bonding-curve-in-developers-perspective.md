# Bonding Curve 开发视角

> Source: https://docs.flap.sh/flap/developers/wallet-and-terminal-and-bot-developers/bonding-curve-in-developers-perspective.md
> Synced: 2026-03-08
> 本地英文镜像: ../en/bonding-curve-in-developers-perspective.md

## 用途

说明如何用链上状态或曲线参数，计算 token 的 reserve/price/fdv/progress，支持离线报价与监控。

## 关键接口与字段

- 推荐读取: `getTokenV5(token)`
- 关键参数: `circulatingSupply`, `r`, `h`, `k`, `dexSupplyThresh`
- 关键事件:
  - `FlapTokenCirculatingSupplyChanged`
  - `TokenCurveSetV2`
  - `TokenDexSupplyThreshSet`

## BSC接入要点

- `r/h/k` 与 `dexSupplyThresh` 可视为“每个 token 基本不变参数”，首次取到后缓存。
- `circulatingSupply` 可实时索引事件更新，降低反复 RPC 查询。
- 进度计算用于判断是否接近迁移到 DEX，可用于 UI 风险提示。

## 常见坑

- 硬编码曲线参数（跨链/版本后会失真）。
- 单位处理错误（wad/ether 精度混淆）。
- 用过期 `circulatingSupply` 做报价，导致滑点超预期。
