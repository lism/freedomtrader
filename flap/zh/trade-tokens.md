# 交易接口（Quote / Swap）

> Source: https://docs.flap.sh/flap/developers/wallet-and-terminal-and-bot-developers/trade-tokens.md
> Synced: 2026-03-08
> 本地英文镜像: ../en/trade-tokens.md

## 用途

定义 Flap Portal 的核心交易流程：先 `quoteExactInput` 预估输出，再 `swapExactInput` 执行交易，并结合事件与离线曲线报价做提速。

## 关键接口与字段

- 报价:
  - `quoteExactInput(QuoteExactInputParams)`
  - 参数: `inputToken`, `outputToken`, `inputAmount`
- 交易:
  - `swapExactInput(ExactInputParams)`
  - 参数: `inputToken`, `outputToken`, `inputAmount`, `minOutputAmount`, `permitData`
- 事件:
  - `TokenBought`
  - `TokenSold`
  - `FlapTokenProgressChanged`
- 离线报价依赖事件:
  - `TokenCreated`
  - `TokenCurveSet/TokenCurveSetV2`
  - `TokenDexSupplyThreshSet`
  - `FlapTokenCirculatingSupplyChanged`
  - `FlapTokenTaxSet`（可选）

## BSC接入要点

- `quoteExactInput` 不是 `view`，但可用 `eth_call` / simulate，不必真实发交易。
- 买卖方向要按 quote token 类型构造 `inputToken/outputToken`（原生币 vs ERC20）。
- 卖出可选 `permitData`，减少一次 `approve` 交易。
- 你的 UI/批量交易逻辑建议：`quote -> 滑点保护(minOutputAmount) -> swap`。

## 常见坑

- 直接用离线价格当成交价，不先走 `quoteExactInput`。
- `minOutputAmount` 保护过宽或未设置，放大滑点风险。
- `permitData` 编码错误导致交易回滚。
- 忽略 token 是否已迁移到 DEX 阶段，错误套用 bonding curve 逻辑。
