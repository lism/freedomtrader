# FreedomRouter v6

BSC 聚合路由合约，统一处理 `Four.meme + Flap + PancakeSwap` 交易路径。

当前版本为 **UUPS 可升级 Proxy**，Proxy 地址固定，后续逻辑升级只替换 Implementation，不需要迁移插件地址。

## 当前能力

- 自动识别 **Four.meme 内盘 / 外盘**
- 自动识别 **Flap Bonding / DEX** 阶段
- 支持 **BNB 底池** 与 **ERC20 底池**（USD1 / USDT / USDC / BUSD / FDUSD）
- 兼容 **TaxToken**
- 提供统一 `buy` / `sell` / `quoteBuy` / `quoteSell` / `getTokenInfo`
- 小费自愿，默认 `tipRate = 0`

## 架构

```text
用户 → FreedomRouter (ERC1967Proxy / UUPS)
         │ delegatecall
         ↓
       FreedomRouterImpl
         ├── Four.meme 内盘
         │    ├── BNB quote      → TM_V2.buyTokenAMAP / sellToken
         │    └── ERC20 quote    → Helper3.buyWithEth / sellForEth
         ├── Four / Flap 外盘    → PancakeSwap
         └── Flap Bonding        → Flap Portal
```

## 合约地址（BSC 主网）

| 合约 | 地址 |
|------|------|
| FreedomRouter (Proxy, UUPS) | [`0x444444444444147c48E01D3669260E33d8b33c93`](https://bscscan.com/address/0x444444444444147c48E01D3669260E33d8b33c93) |
| FreedomRouterImpl | [`0xc7B76F939CbC84d7a7077411974A5CbC9dfb3Bbd`](https://bscscan.com/address/0xc7B76F939CbC84d7a7077411974A5CbC9dfb3Bbd) |
| TokenManager V2 | [`0x5c952063c7fc8610FFDB798152D69F0B9550762b`](https://bscscan.com/address/0x5c952063c7fc8610FFDB798152D69F0B9550762b) |
| TokenManagerHelper3 | [`0xF251F83e40a78868FcfA3FA4599Dad6494E46034`](https://bscscan.com/address/0xF251F83e40a78868FcfA3FA4599Dad6494E46034) |
| Flap Portal | [`0xe2cE6ab80874Fa9Fa2aAE65D277Dd6B8e65C9De0`](https://bscscan.com/address/0xe2cE6ab80874Fa9Fa2aAE65D277Dd6B8e65C9De0) |
| PancakeSwap Router | [`0x10ED43C718714eb63d5aA57B78B54704E256024E`](https://bscscan.com/address/0x10ED43C718714eb63d5aA57B78B54704E256024E) |

## 核心接口

### `buy(token, amountOutMin, tipRate, deadline)` payable

用 BNB 买入代币，自动判断走 Four 内盘、Flap Portal 还是 PancakeSwap。

```js
await router.buy(tokenAddress, 0, 0, deadline, { value: parseEther("0.1") });
```

### `sell(token, amountIn, amountOutMin, tipRate, deadline)`

卖出代币换 BNB，实际授权目标请以 `getTokenInfo(...).approveTarget` 为准，不要在前端硬编码。

```js
const info = await router.getTokenInfo(tokenAddress, user);
await token.approve(info.approveTarget, MaxUint256);
await router.sell(tokenAddress, amountIn, 0, 0, deadline);
```

### `quoteBuy(token, amountIn)` / `quoteSell(token, amountIn)`

统一报价接口。部分路径不是 `view`，应使用 `eth_call` 模拟调用。

### `getTokenInfo(token, user)`

一次调用拿到完整路由和展示信息，重点字段：

```js
const info = await router.getTokenInfo(tokenAddress, userAddress);
// info.routeSource      → 路由来源枚举
// info.approveTarget    → 当前卖出应授权给谁
// info.tmQuote          → Four 内盘 quote token
// info.flapStatus       → Flap 状态（Bonding / DEX）
// info.flapProgress     → Flap 进度
// info.hasLiquidity     → Pancake 是否有池子
// info.isTaxToken       → Four TaxToken 标记
```

## 路由枚举

| routeSource | 含义 |
|-------------|------|
| `0` | NONE |
| `1` | FOUR_INTERNAL_BNB |
| `2` | FOUR_INTERNAL_ERC20 |
| `3` | FOUR_EXTERNAL |
| `4` | FLAP_BONDING |
| `5` | FLAP_BONDING_SELL |
| `6` | FLAP_DEX |
| `7` | PANCAKE_ONLY |

## 小费

完全自愿，`tipRate` 参数控制：

| tipRate | 比例 |
|---------|------|
| `0` | 0% |
| `10` | 0.1% |
| `100` | 1% |
| `500` | 5%（上限） |

## 开发

```bash
npm install
npx hardhat compile
```

## 部署与升级

### 普通部署

```bash
npx hardhat run scripts/deploy.js --network bsc
```

### CREATE2 靓号部署

1. 一次性准备 Factory + Impl，并输出矿机命令

```bash
npx hardhat run scripts/prepare-vanity.js --network bsc
```

2. 用 `vanity-params.json` 输出的 `factory + initCodeHash` 在矿机上挖 salt

3. 挖到 salt 后部署 Proxy

```bash
DEPLOY_SALT=0x... npx hardhat run scripts/deploy-vanity.js --network bsc
```

### UUPS 升级

```bash
PROXY_ADDRESS=0x444444444444147c48E01D3669260E33d8b33c93 \
npx hardhat run scripts/upgrade.js --network bsc
```

## 测试

配置 `.env`：

```env
PRIVATE_KEY=0x...
BSCSCAN_API_KEY=...
ROUTER_ADDRESS=0x444444444444147c48E01D3669260E33d8b33c93
TOKEN_ADDRESS=0x...
CMD=info
TIP=0
```

执行：

```bash
npx hardhat run scripts/test.js --network bsc
```

## License

MIT
