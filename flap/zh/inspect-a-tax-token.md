# Inspect Tax Token

> Source: https://docs.flap.sh/flap/developers/wallet-and-terminal-and-bot-developers/inspect-a-tax-token.md
> Synced: 2026-03-08
> 本地英文镜像: ../en/inspect-a-tax-token.md

## 用途

查询税币配置与统计（营销、分红、流动性、销毁等），并补充税币专属的持仓/分红/金库视角。

## 关键接口与字段

- Tax Token Helper:
  - BNB Mainnet: `0x53841c73217735F37BC1775538b03b23feFD8346`
  - BNB Testnet: `0xD64441e5FcD02D342B8cf6eBA10Ef6E40d0dA90f`
- 关键方法:
  - `getTaxTokenInfo(taxToken)`
  - `getDividendInfo(taxToken, user)`
  - `claimDividend(...)`
- 关键字段:
  - `taxRate`
  - `marketBps/deflationBps/lpBps/dividendBps`
  - `totalQuoteSentToMarketing`
  - `quoteToken`
  - `marketingWallet`

## BSC接入要点

- 交易前可先读 `taxRate` 估算实际到手，避免误判滑点。
- 对老 V1 税币，`totalQuoteSentToMarketing` 可能不准确，文档给了后备查询接口。
- 税币配套可再查 VaultPortal，补充金库侧状态。

## 常见坑

- 把普通 token 当税币走税字段解析。
- 忽略 V1/V2 税币差异，导致统计字段解释错误。
- 未将税率纳入离线报价，导致预估和成交偏差大。
