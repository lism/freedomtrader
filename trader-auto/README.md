# trader-auto

基于当前 `freedomtrader` 合约与路由常量实现的独立自动交易服务。

当前版本提供：

- `Four.meme TokenCreate` 链上事件监听
- `Pancake V2 PairCreated` 新池监听
- `最低流动性 / creator 黑名单 / 首笔成交额` 风控
- 自动买入
- ROI 监控
- 达到止盈 / 止损后自动卖出
- 本地状态持久化

## 使用

1. 在 `trader-auto` 下安装依赖：`npm install`
2. 复制 `.env.example` 为 `.env`
3. 填写 `PRIVATE_KEY`
4. 启动：`npm start`

## 说明

- Four.meme 监听源直接读取 `0x5c952063c7fc8610FFDB798152D69F0B9550762b` 的 `TokenCreate` 事件。
- Pancake 监听源默认读取 `0xcA143Ce32Fe78f1f7019d7d551a6402fC5350c73` 的 `PairCreated` 事件，只抓和 `WBNB` 配对的新池。
- `MIN_LIQUIDITY_BNB` 会过滤掉初始资金太小的池子。
- `MIN_FIRST_SWAP_BNB` 只对 Pancake 新池生效，表示新池创建后第一笔 `Swap` 的 WBNB 金额阈值。
- `CREATOR_BLOCKLIST` 支持逗号分隔地址黑名单。
- 默认 `DRY_RUN=true`，先只打印信号与预计交易，不真实下单。
- 系统当前是单钱包版本，便于先验证策略闭环。
- `START_BLOCK` 和 `PANCAKE_START_BLOCK` 都是可选；不填时默认从最近几个块开始追踪。



QuickNode (公认速度最快之一，免费额度做个人打狗完全够用)
Alchemy / NodeReal (NodeReal 是 Binance 官方背后的技术提供商，它的免费版叫 MegaNode，速度极快)
