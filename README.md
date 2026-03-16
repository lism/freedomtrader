# Freedom Trader

BSC + Solana 双链聚合交易终端 — Chrome 侧边栏扩展。

**0 手续费**，多钱包批量交易，一键买卖，秒级上链。覆盖 Pump.fun / PumpSwap / Four.meme / Flap / PancakeSwap，自动识别交易路径。

## 功能

- **双链支持** — BSC 和 Solana 顶部一键切换，钱包、余额、LP 信息无缝联动
- **自动路由** — 自动识别代币所属协议和阶段（内盘/外盘），无需手动选择
- **多钱包批量交易** — 多钱包并行下单，百分比卖出
- **稳定币报价** — 支持 BNB / USDT / USDC 三种报价代币，稳定币路由直接走 PCS 最优池
- **Jito Bundle 加速** — SOL 交易同时发送 RPC + Jito Block Engine 双通道
- **Token-2022** — 原生支持 Solana Token-2022 标准
- **密码锁** — PBKDF2 + AES-256-GCM 加密私钥，超时自动锁定
- **暗色主题** — Light / Dark 一键切换
- **自定义快捷键** — 快速买卖金额、滑点、百分比卖出，自由配置
- **0 手续费** — 小费完全自愿，默认 0

## BSC 交易路径

| 协议 | 阶段 | 路由 |
|------|------|------|
| Four.meme | 内盘 (BNB/ERC20) | TokenManager 直接买卖 |
| Four.meme | 外盘 | PancakeSwap |
| Flap | Bonding | Portal 买卖 |
| Flap | DEX | PancakeSwap |
| PancakeSwap | — | 自动匹配最优报价池 |

FreedomRouter 合约统一入口 `trade(tokenIn, tokenOut, amountIn, amountOutMin, tipRate, deadline)`，自动判断路径。

## Solana 交易路径

| 阶段 | 协议 | 说明 |
|------|------|------|
| 未毕业 | Pump.fun Bonding Curve | 内盘直接买卖，自动创建 ATA |
| 已毕业 | PumpSwap AMM | 外盘流动池交易，SOL ↔ WSOL 自动封装 |

自动识别代币阶段。支持 SPL Token 和 Token-2022。

## 安全性

- **私钥不上传服务器** — 只在本地 Service Worker 后台解密和签名
- **前端页面拿不到明文** — Session Storage 限制为 `TRUSTED_CONTEXTS`，UI 页面无法读取
- **私钥加密存储** — `PBKDF2 + AES-256-GCM`，密钥不直接存储
- **自动锁定** — 无操作超时自动锁定（默认 4 小时）
- **链上时效保护** — BSC 交易统一带 `deadline`
- **授权目标由合约返回** — `approveTarget` 避免错误授权
- **源码可审计** — FreedomRouter Proxy 与 Impl 已完成 BscScan 验证

## 合约地址（BSC 主网）

| 合约 | 地址 |
|------|------|
| FreedomRouter v6.3 (Proxy) | [`0xCd4D70bb991289b5A8522adB93Cd3C4b93B4Dceb`](https://bscscan.com/address/0xCd4D70bb991289b5A8522adB93Cd3C4b93B4Dceb) |
| FreedomRouterImpl v6.3 | [`0x5D39731797093ECf9eE2D117f7aD8bB6da82Da82`](https://bscscan.com/address/0x5D39731797093ECf9eE2D117f7aD8bB6da82Da82) |
| TokenManager V2 | [`0x5c952063c7fc8610FFDB798152D69F0B9550762b`](https://bscscan.com/address/0x5c952063c7fc8610FFDB798152D69F0B9550762b) |
| TokenManagerHelper3 | [`0xF251F83e40a78868FcfA3FA4599Dad6494E46034`](https://bscscan.com/address/0xF251F83e40a78868FcfA3FA4599Dad6494E46034) |
| Flap Portal | [`0xe2cE6ab80874Fa9Fa2aAE65D277Dd6B8e65C9De0`](https://bscscan.com/address/0xe2cE6ab80874Fa9Fa2aAE65D277Dd6B8e65C9De0) |

## 平台自动识别

浏览以下平台时，插件自动提取合约地址并识别所属链：

| 平台 | BSC | SOL |
|------|:---:|:---:|
| [GMGN](https://gmgn.ai) | ✓ | ✓ |
| [DexScreener](https://dexscreener.com) | ✓ | ✓ |
| [Birdeye](https://birdeye.so) | ✓ | ✓ |
| [Photon](https://photon-sol.tinyastro.io) | ✓ | ✓ |
| [Pump.fun](https://pump.fun) | — | ✓ |
| [Debot](https://debot.io) | ✓ | — |
| [PancakeSwap](https://pancakeswap.finance) | ✓ | — |
| [DexTools](https://www.dextools.io) | ✓ | — |
| [PooCoin](https://poocoin.app) | ✓ | — |
| [BscScan](https://bscscan.com) | ✓ | — |
| [Solscan](https://solscan.io) | — | ✓ |

## RPC 建议

交易速度与 RPC 延迟直接相关。**强烈建议使用专用 RPC**。

### BSC

建议使用**隐私防夹 RPC**，公共 RPC 的交易进入公开 mempool，容易被 MEV 夹子攻击。

| RPC | 说明 |
|-----|------|
| `https://rpc.48.club` | 隐私防夹 |
| `https://debot.bsc.blockrazor.xyz` | 隐私防夹 |
| `https://bsc-dataseed.binance.org` | 公共，无隐私保护 |

### Solana

推荐 [GetBlock](https://getblock.io)。同时配置 HTTP + WSS 两个端点效果最佳。

| 类型 | 说明 |
|------|------|
| HTTP | 发送交易和查询状态 |
| WSS | WebSocket 订阅确认（可选但推荐） |

## 快速开始

### 下载插件

1. 打开 [GitHub Actions](../../actions/workflows/build-extension.yml) 页面
2. 点击最新一次成功的构建
3. 下载 Artifacts 压缩包，解压后加载到 Chrome

### 本地构建

```bash
cd trader-extension && npm install && npm run build
```

构建产物在 `trader-extension/dist/`，Chrome 加载该目录即可。

### 编译合约

```bash
cd FreedomRouter && npm install && npx hardhat compile
```

## 小费

完全自愿，`tipRate` 参数控制（默认 0 = 免费，上限 5%）。

BSC：[`0x2De78dd769679119b4B3a158235678df92E98319`](https://bscscan.com/address/0x2De78dd769679119b4B3a158235678df92E98319)（合约硬编码）

SOL：[`D6kPpTmJQA3eCLAZVJj8c3JKsrmHzm9q9sTQu6BvzPxP`](https://solscan.io/account/D6kPpTmJQA3eCLAZVJj8c3JKsrmHzm9q9sTQu6BvzPxP)

## 项目结构

```
FreedomRouter/             BSC 聚合路由合约（Hardhat, UUPS 可升级）
trader-extension/          Chrome 侧边栏扩展
├── src/
│   ├── background.js      Service Worker — 私钥签名、加密
│   ├── trader.js          入口
│   ├── state.js           全局状态
│   ├── ui.js              UI 逻辑与链切换
│   ├── trading.js         BSC 交易（FreedomRouter）
│   ├── token-bsc.js       BSC 代币检测（路由/报价/余额）
│   ├── token-sol.js       SOL 代币检测
│   ├── sol-trading.js     SOL 交易封装
│   ├── sol/               Solana 核心模块
│   │   ├── trading.js     买卖 + Jito 双发
│   │   ├── bonding-curve.js  BC 报价与指令
│   │   ├── pump-swap.js   AMM 交易指令
│   │   ├── connection.js  RPC + Blockhash 预取
│   │   ├── accounts.js    链上账户解析
│   │   └── pda.js         PDA 派生
│   ├── batch.js           多钱包批量交易
│   ├── crypto.js          前端 ↔ SW 消息代理
│   ├── wallet.js          钱包路由
│   ├── lock.js            密码锁 UI
│   └── theme.js           暗色主题
└── scripts/
    └── test-regressions.mjs  回归测试
```

## License

[MIT](LICENSE)
