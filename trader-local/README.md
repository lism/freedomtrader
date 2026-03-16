# Freedom Trader 本地交易系统

> BSC + Solana 双链聚合交易终端 — 命令行版

本系统是 [Freedom Trader Chrome 扩展](../trader-extension/) 的本地 Node.js 版本，无需浏览器即可在命令行中完成代币检测、买入、卖出和批量交易。

---

## 目录

- [环境要求](#环境要求)
- [安装](#安装)
- [快速开始](#快速开始)
- [命令详解](#命令详解)
  - [钱包管理](#钱包管理)
  - [代币信息](#代币信息)
  - [买入](#买入)
  - [卖出](#卖出)
  - [配置管理](#配置管理)
- [配置文件说明](#配置文件说明)
- [安全说明](#安全说明)
- [项目结构](#项目结构)
- [常见问题](#常见问题)

---

## 环境要求

- **Node.js** >= 18.0（需要原生 `crypto` 模块及 ES Module 支持）
- **npm** >= 8.0

## 安装

```bash
cd trader-local
npm install
```

安装完成后即可使用。所有命令通过 `node src/index.js` 执行。

---

## 快速开始

### 1. 首次使用 — 设置密码

第一次运行任何需要钱包的命令时，系统会要求设置加密密码。此密码用于加密存储所有私钥。

```bash
node src/index.js wallet list
# 🔐 首次使用，请设置加密密码:
#   密码: ********
```

> ⚠️ 密码丢失将无法恢复私钥，请牢记！

### 2. 添加钱包

```bash
# 添加 BSC 钱包
node src/index.js wallet add --name "主钱包" --chain bsc --key 0xYOUR_PRIVATE_KEY

# 添加 SOL 钱包
node src/index.js wallet add --name "SOL钱包" --chain sol --key YOUR_BASE58_PRIVATE_KEY
```

### 3. 查看余额

```bash
node src/index.js wallet balance
```

### 4. 买入代币

```bash
# BSC（自动识别 0x 地址）
node src/index.js buy 0xTOKEN_ADDRESS 0.01

# SOL（自动识别 base58 地址）
node src/index.js buy 7GCihgDB8fe6KNjn2MYtkzZcRjQy3t9GHdC8uHYmW2hr 0.1
```

### 5. 卖出代币

```bash
# 按百分比清仓
node src/index.js sell 0xTOKEN_ADDRESS 100%

# 卖出 50%
node src/index.js sell 0xTOKEN_ADDRESS 50%
```

---

## 命令详解

### 钱包管理

#### `wallet add` — 添加钱包

```bash
node src/index.js wallet add --name <名称> --chain <bsc|sol> --key <私钥>
```

| 参数 | 说明 | 默认值 |
|---|---|---|
| `--name` | 钱包名称（用于显示） | `钱包{时间戳}` |
| `--chain` | 链类型：`bsc` 或 `sol` | `bsc` |
| `--key` | 私钥（BSC: 0x 开头的 hex; SOL: base58） | 必填 |

**示例：**

```bash
# BSC 钱包
node src/index.js wallet add --name "交易钱包1" --chain bsc --key 0xabcdef1234567890...

# SOL 钱包（支持 64 字节密钥）
node src/index.js wallet add --name "SOL主钱包" --chain sol --key 5KjR2h...base58key
```

#### `wallet list` — 列出所有钱包

```bash
node src/index.js wallet list
```

输出示例：
```
📋 BSC 钱包:
  [✓] 交易钱包1 | 0x742d35Cc6634C0532925a3b844Bc9e7595f2bD18
  [ ] 备用钱包   | 0x8Ba1f109551bD432803012645Ac136ddd64DBA72

📋 SOL 钱包:
  [✓] SOL主钱包  | 7xKXtg2CW87d97TXJSDpbD5jBkheTqA83TZRuJosgAsU
```

`[✓]` 表示激活状态的钱包，交易时会使用这些钱包。

#### `wallet balance` — 查看所有钱包余额

```bash
node src/index.js wallet balance
```

输出示例：
```
💰 BSC 余额:
  交易钱包1: 1.2345 BNB | 0x742d...bD18
  总计: 1.2345 BNB

💰 SOL 余额:
  SOL主钱包: 5.6789 SOL | 7xKX...AsU
  总计: 5.6789 SOL
```

---

### 代币信息

#### `info` — 检测代币信息

```bash
node src/index.js info <代币地址>
```

系统自动根据地址格式识别是 BSC（0x 开头）还是 SOL（base58），然后查询并显示代币信息：

- 代币名称、符号、精度
- 总供应量、持有余额
- LP/交易池信息（Four.meme / Flap / PancakeSwap / Pump.fun / PumpSwap）
- 路由来源和交易状态

**示例：**

```bash
# BSC 代币
node src/index.js info 0x1234567890abcdef1234567890abcdef12345678

# SOL 代币
node src/index.js info 7GCihgDB8fe6KNjn2MYtkzZcRjQy3t9GHdC8uHYmW2hr
```

---

### 买入

#### `buy` — 买入代币

```bash
node src/index.js buy <代币地址> <数量> [--slippage <滑点>] [--gas <Gas>]
```

| 参数 | 说明 | 默认值 |
|---|---|---|
| `<代币地址>` | 代币合约地址 | 必填 |
| `<数量>` | 买入金额（BSC: BNB; SOL: SOL） | 必填 |
| `--slippage` | 滑点百分比 | 配置值 (15) |
| `--gas` | BSC Gas Price (Gwei) | 配置值 (3) |

**工作流程：**

1. 自动检测代币信息和 LP
2. 通过 FreedomRouter 智能路由（Four.meme / Flap / PancakeSwap）
3. 买入后自动 approve 卖出授权
4. 多钱包激活时自动批量并发买入

**示例：**

```bash
# 用 0.01 BNB 买入，默认滑点
node src/index.js buy 0xTOKEN 0.01

# 用 0.5 SOL 买入，设置 20% 滑点
node src/index.js buy 7GCi...mint 0.5 --slippage 20

# 指定 Gas Price
node src/index.js buy 0xTOKEN 0.05 --gas 5
```

---

### 卖出

#### `sell` — 卖出代币

```bash
node src/index.js sell <代币地址> <数量|百分比%> [--slippage <滑点>] [--gas <Gas>]
```

| 参数 | 说明 | 默认值 |
|---|---|---|
| `<代币地址>` | 代币合约地址 | 必填 |
| `<数量\|百分比%>` | 卖出数量或百分比（带 `%` 后缀） | 必填 |
| `--slippage` | 滑点百分比 | 配置值 (15) |
| `--gas` | BSC Gas Price (Gwei) | 配置值 (3) |

**卖出模式：**

- **按数量卖出**：`sell 0xTOKEN 1000` — 卖出 1000 个代币
- **按百分比卖出**：`sell 0xTOKEN 50%` — 卖出持仓的 50%
- **清仓**：`sell 0xTOKEN 100%`

**示例：**

```bash
# 卖出 50%
node src/index.js sell 0xTOKEN 50%

# 清仓
node src/index.js sell 0xTOKEN 100%

# 按数量卖出
node src/index.js sell 0xTOKEN 5000 --slippage 25

# SOL 代币清仓
node src/index.js sell 7GCi...mint 100%
```

---

### 配置管理

#### `config show` — 查看当前配置

```bash
node src/index.js config show
```

输出：
```
⚙️  当前配置:
  BSC RPC:        https://bsc-dataseed.bnbchain.org
  SOL RPC:        https://solana-rpc.publicnode.com
  SOL WSS:        (自动)
  Tip Rate:       0%
  Slippage:       15%
  Gas Price:      3 Gwei
  SOL Priority:   0.0001 SOL
  SOL Jito Tip:   0.0001 SOL
```

#### `config set` — 修改配置

```bash
node src/index.js config set <key> <value>
```

**可用配置项：**

| Key | 说明 | 示例值 |
|---|---|---|
| `rpcUrl` | BSC RPC 节点地址 | `https://bsc-rpc.example.com` |
| `solRpcUrl` | SOL RPC 节点地址 | `https://api.mainnet-beta.solana.com` |
| `solWssUrl` | SOL WebSocket 地址 | `wss://api.mainnet-beta.solana.com` |
| `tipRate` | 小费费率 (0-5%) | `0` |
| `slippage` | 默认滑点 (%) | `15` |
| `gasPrice` | BSC Gas Price (Gwei) | `3` |
| `solPriorityFee` | SOL 优先费 (SOL) | `0.0001` |
| `solJitoTip` | SOL Jito 加速费 (SOL) | `0.0001` |

**示例：**

```bash
# 切换 RPC 节点
node src/index.js config set rpcUrl https://bsc-rpc.example.com

# 调大滑点
node src/index.js config set slippage 25

# 调高 Jito 加速费
node src/index.js config set solJitoTip 0.001
```

---

## 配置文件说明

运行时会在 `trader-local/` 目录下自动生成以下文件：

| 文件 | 说明 | 是否敏感 |
|---|---|---|
| `config.json` | RPC / 滑点 / Gas 等配置 | 否 |
| `wallets.enc.json` | 加密后的钱包私钥 + 密码盐值 | **⚠️ 是** |
| `.approve-cache.json` | ERC20 授权缓存（避免重复 approve） | 否 |

> ⚠️ **`wallets.enc.json` 包含加密的私钥，请勿泄露此文件。** 虽然需要密码才能解密，但仍建议妥善保管。

---

## 安全说明

### 密钥加密

- 所有私钥使用 **AES-256-GCM** 加密存储
- 加密密钥由用户密码通过 **PBKDF2**（100,000 次迭代）派生
- 私钥仅在交易时临时解密到内存，交易完成后进程退出

### 与 Chrome 扩展的区别

| | Chrome 扩展 | 本地系统 |
|---|---|---|
| 私钥隔离 | Background Service Worker 隔离签名 | 进程内直接签名 |
| 加密格式 | Web Crypto API | Node.js crypto |
| 兼容性 | 两者密钥**不互通**，需要重新导入 | — |

### 安全建议

1. **设置强密码**（至少 8 位，包含字母和数字）
2. **不要将 `wallets.enc.json` 提交到 Git**（已包含在 `.gitignore`）
3. **在安全的本地环境中运行**，避免在共享服务器上使用
4. **定期备份私钥**到离线存储

---

## 项目结构

```
trader-local/
├── package.json               # 项目配置
├── config.json                # 运行配置（自动生成）
├── wallets.enc.json           # 加密钱包（自动生成）
├── .approve-cache.json        # 授权缓存（自动生成）
├── README.md                  # 本文档
└── src/
    ├── index.js               # CLI 入口 + 命令路由
    ├── config.js              # JSON 文件配置管理
    ├── state.js               # 全局运行状态
    ├── crypto.js              # AES-GCM 加密/解密
    ├── constants.js           # BSC 合约地址 + ABI
    ├── utils.js               # 工具函数
    ├── wallet-bsc.js          # BSC 钱包管理 + 合约调用
    ├── wallet-sol.js          # SOL 钱包管理 + 签名
    ├── token-bsc.js           # BSC 代币检测
    ├── token-sol.js           # SOL 代币检测
    ├── trading-bsc.js         # BSC 买入/卖出逻辑
    ├── trading-sol.js         # SOL 买入/卖出封装
    ├── batch.js               # 多钱包批量交易
    └── sol/                   # Solana 核心模块
        ├── constants.js       # Pump.fun 程序地址
        ├── connection.js      # RPC 连接管理
        ├── pda.js             # PDA 地址推导
        ├── accounts.js        # 链上账户解析
        ├── bonding-curve.js   # Bonding Curve 交易
        ├── pump-swap.js       # PumpSwap AMM 交易
        └── trading.js         # SOL 交易核心逻辑
```

---

## 常见问题

### Q: 报错 `❌ 密码错误`

每次运行命令都需要输入正确密码。如果忘记密码，需要删除 `wallets.enc.json` 重新导入钱包。

### Q: 报错 `❌ 未找到 LP，无法交易`

代币可能尚未创建流动性池，或合约地址不正确。先用 `info` 命令检测：

```bash
node src/index.js info 0xTOKEN_ADDRESS
```

### Q: 如何切换到自定义 RPC 节点？

```bash
# BSC
node src/index.js config set rpcUrl https://your-bsc-rpc.com

# SOL
node src/index.js config set solRpcUrl https://your-sol-rpc.com
```

### Q: 多钱包时如何指定只用某个钱包？

当前版本会使用所有激活状态的钱包。钱包的激活状态存储在 `config.json` 的 `activeWalletIds` / `solActiveWalletIds` 字段中。

### Q: 交易超时怎么办？

- BSC 交易 deadline 为 10 秒，确认超时为 120 秒
- SOL 交易使用预取的 blockhash，超时后自动放弃
- 可以通过调高 Gas/Priority Fee 加速：

```bash
node src/index.js config set gasPrice 5         # BSC: 5 Gwei
node src/index.js config set solPriorityFee 0.001  # SOL
node src/index.js config set solJitoTip 0.001      # SOL Jito 加速
```

### Q: 如何启用调试模式？

设置 `DEBUG` 环境变量可显示完整错误堆栈：

```bash
# Windows
set DEBUG=1 && node src/index.js buy 0xTOKEN 0.01

# Linux/Mac
DEBUG=1 node src/index.js buy 0xTOKEN 0.01
```

---

## 支持的交易路由

### BSC

| 路由 | 说明 |
|---|---|
| Four.meme 内盘 (BNB) | Four.meme 代币 BNB 报价内盘交易 |
| Four.meme 内盘 (ERC20) | Four.meme 代币 ERC20 报价内盘交易 |
| Four.meme 外盘 | Four.meme 代币毕业后的 PancakeSwap 交易 |
| Flap Bonding Curve | Flap 平台 Bonding Curve 交易 |
| Flap DEX | Flap 代币毕业后的 DEX 交易 |
| PancakeSwap | 标准 PancakeSwap V2 路由 |

### Solana

| 路由 | 说明 |
|---|---|
| Pump.fun Bonding Curve | 内盘曲线交易 |
| PumpSwap AMM | 毕业后的 AMM 池交易 |

---

## License

MIT
