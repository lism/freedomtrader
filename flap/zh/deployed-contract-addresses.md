# 合约部署地址（BSC）

> Source: https://docs.flap.sh/flap/developers/wallet-and-terminal-and-bot-developers/deployed-contract-addresses.md
> Synced: 2026-03-08
> 本地英文镜像: ../en/deployed-contract-addresses.md

## 用途

用于确定你在 BSC 主网/测试网接入 Flap 时应调用的 Portal 与相关实现合约地址，并拿到官方 ABI。

## 关键接口与字段

- BNB Mainnet Portal: `0xe2cE6ab80874Fa9Fa2aAE65D277Dd6B8e65C9De0`
- BNB Testnet Portal: `0x5bEacaF7ABCbB3aB280e80D007FD31fcE26510e9`
- BNB Mainnet 版本: `v5.8.6`
- BNB Testnet 版本: `v5.8.5`
- 本地 ABI 资产: `../assets/deployed-contract-addresses__portal-abi.json`

## BSC接入要点

- 前端/脚本初始化时，将 BSC 主网 Portal 设为默认入口合约。
- 报价和交易调用都围绕 Portal 接口进行，不要直接依赖旧版私有接口。
- 版本差异会影响可用字段（如 `getTokenV7` 的覆盖范围），需要结合 `tokenVersion` 做分支兼容。

## 常见坑

- 把测试网地址误用于主网。
- ABI 来自非官方渠道，导致字段顺序不一致。
- 只保存 Portal 地址，遗漏 Tax Token 相关实现地址，后续调试困难。
