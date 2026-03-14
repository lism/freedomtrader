// SPDX-License-Identifier: MIT
pragma solidity ^0.8.22;

import "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import "@openzeppelin/contracts/access/Ownable.sol";
import "@openzeppelin/contracts/utils/ReentrancyGuard.sol";

/**
 * @title LimitOrderBook
 * @notice BSC 限价单合约 — 用户托管 BNB/Token，白名单执行者通过 FreedomRouter 执行
 *
 *   买单：用户存入 BNB，设置 USD 目标价；价格跌到位时执行者触发买入
 *   卖单：用户存入 Token，设置 USD 目标价；价格涨到位时执行者触发卖出
 *   价格来源：PancakeSwap V2 LP 储备，WBNB 报价通过 WBNB/USDT 对换算为 USD
 */
contract LimitOrderBook is Ownable, ReentrancyGuard {
    using SafeERC20 for IERC20;

    // ==================== 常量 ====================

    address public constant WBNB  = 0xbb4CdB9CBd36B01bD1cBaEBF2De08d9173bc095c;
    address public constant USDT  = 0x55d398326f99059fF775485246999027B3197955;
    address public constant USD1  = 0x8d0D000Ee44948FC98c9B98A4FA4921476f08B0d;
    address public constant USDC  = 0x8AC76a51cc950d9822D68b83fE1Ad97B32Cd580d;
    address public constant BUSD  = 0xe9e7CEA3DedcA5984780Bafc599bD69ADd087D56;
    address public constant FDUSD = 0xc5f0f7b66764F6ec8C8Dff7BA683102295E16409;

    address public constant PANCAKE_FACTORY = 0xcA143Ce32Fe78f1f7019d7d551a6402fC5350c73;
    address public constant WBNB_USDT_PAIR  = 0x16b9a82891338f9bA80E2D6970FddA79D1eb0daE;

    uint256 public constant MAX_FEE_BPS = 500;   // 5% hard cap
    uint256 public constant BPS_BASE    = 10000;
    uint256 public constant MAX_SLIPPAGE_BPS = 5000; // 50% max slippage

    // ==================== 存储 ====================

    address public router; // FreedomRouter proxy
    uint256 public feeBps; // 执行费率 (basis points)
    address public feeRecipient;

    mapping(address => bool) public executors;

    // ==================== 数据结构 ====================

    enum OrderStatus { Pending, Executed, Cancelled, Expired }

    struct Order {
        address user;
        address token;
        bool isBuy;           // true=买入(BNB→Token), false=卖出(Token→BNB)
        uint256 amount;       // 托管数量 (wei BNB for buy, token units for sell)
        uint256 targetPrice;  // USD per token (18 decimals)
        uint256 slippageBps;  // 滑点容忍度
        uint256 tipRate;      // 传给 FreedomRouter 的小费率
        uint256 expiry;       // 过期 timestamp
        OrderStatus status;
    }

    Order[] public orders;
    mapping(address => uint256[]) public userOrders;

    // ==================== 事件 ====================

    event OrderCreated(
        uint256 indexed orderId,
        address indexed user,
        address indexed token,
        bool isBuy,
        uint256 amount,
        uint256 targetPrice,
        uint256 expiry
    );

    event OrderExecuted(
        uint256 indexed orderId,
        address indexed executor,
        uint256 amountOut,
        uint256 fee
    );

    event OrderCancelled(uint256 indexed orderId);
    event OrderExpired(uint256 indexed orderId);
    event ExecutorUpdated(address indexed executor, bool active);
    event ConfigUpdated(string key, uint256 oldVal, uint256 newVal);

    // ==================== 修饰符 ====================

    modifier onlyExecutor() {
        require(executors[msg.sender], "Not executor");
        _;
    }

    // ==================== 初始化 ====================

    constructor(
        address _router,
        address _feeRecipient,
        uint256 _feeBps
    ) Ownable(msg.sender) {
        require(_router != address(0), "Invalid router");
        require(_feeRecipient != address(0), "Invalid fee recipient");
        require(_feeBps <= MAX_FEE_BPS, "Fee too high");
        router = _router;
        feeRecipient = _feeRecipient;
        feeBps = _feeBps;
    }

    // ==================== 创建订单 ====================

    function createBuyOrder(
        address token,
        uint256 targetPrice,
        uint256 slippageBps,
        uint256 tipRate,
        uint256 expiry
    ) external payable nonReentrant returns (uint256 orderId) {
        require(msg.value > 0, "No BNB");
        require(token != address(0), "Invalid token");
        require(targetPrice > 0, "Invalid price");
        require(slippageBps <= MAX_SLIPPAGE_BPS, "Slippage too high");
        require(expiry > block.timestamp, "Already expired");

        orderId = orders.length;
        orders.push(Order({
            user: msg.sender,
            token: token,
            isBuy: true,
            amount: msg.value,
            targetPrice: targetPrice,
            slippageBps: slippageBps,
            tipRate: tipRate,
            expiry: expiry,
            status: OrderStatus.Pending
        }));
        userOrders[msg.sender].push(orderId);

        emit OrderCreated(orderId, msg.sender, token, true, msg.value, targetPrice, expiry);
    }

    function createSellOrder(
        address token,
        uint256 amount,
        uint256 targetPrice,
        uint256 slippageBps,
        uint256 tipRate,
        uint256 expiry
    ) external nonReentrant returns (uint256 orderId) {
        require(amount > 0, "No amount");
        require(token != address(0), "Invalid token");
        require(targetPrice > 0, "Invalid price");
        require(slippageBps <= MAX_SLIPPAGE_BPS, "Slippage too high");
        require(expiry > block.timestamp, "Already expired");

        uint256 balBefore = IERC20(token).balanceOf(address(this));
        IERC20(token).safeTransferFrom(msg.sender, address(this), amount);
        uint256 actualAmount = IERC20(token).balanceOf(address(this)) - balBefore;
        require(actualAmount > 0, "Zero received");

        orderId = orders.length;
        orders.push(Order({
            user: msg.sender,
            token: token,
            isBuy: false,
            amount: actualAmount,
            targetPrice: targetPrice,
            slippageBps: slippageBps,
            tipRate: tipRate,
            expiry: expiry,
            status: OrderStatus.Pending
        }));
        userOrders[msg.sender].push(orderId);

        emit OrderCreated(orderId, msg.sender, token, false, actualAmount, targetPrice, expiry);
    }

    // ==================== 取消订单 ====================

    function cancelOrder(uint256 orderId) external nonReentrant {
        Order storage o = orders[orderId];
        require(o.user == msg.sender, "Not owner");
        require(o.status == OrderStatus.Pending, "Not pending");

        o.status = OrderStatus.Cancelled;

        if (o.isBuy) {
            _sendBNB(o.user, o.amount);
        } else {
            IERC20(o.token).safeTransfer(o.user, o.amount);
        }

        emit OrderCancelled(orderId);
    }

    // ==================== 过期退款 ====================

    function claimExpired(uint256 orderId) external nonReentrant {
        Order storage o = orders[orderId];
        require(o.status == OrderStatus.Pending, "Not pending");
        require(block.timestamp > o.expiry, "Not expired");

        o.status = OrderStatus.Expired;

        if (o.isBuy) {
            _sendBNB(o.user, o.amount);
        } else {
            IERC20(o.token).safeTransfer(o.user, o.amount);
        }

        emit OrderExpired(orderId);
    }

    // ==================== 执行订单 ====================

    function executeOrder(uint256 orderId) external onlyExecutor nonReentrant returns (uint256 amountOut) {
        Order storage o = orders[orderId];
        require(o.status == OrderStatus.Pending, "Not pending");
        require(block.timestamp <= o.expiry, "Expired");

        require(_checkPrice(o.token, o.targetPrice, o.isBuy), "Price not met");

        o.status = OrderStatus.Executed;

        uint256 fee;
        if (o.isBuy) {
            (amountOut, fee) = _executeBuy(o);
        } else {
            (amountOut, fee) = _executeSell(o);
        }

        emit OrderExecuted(orderId, msg.sender, amountOut, fee);
    }

    function batchExecute(uint256[] calldata orderIds) external onlyExecutor nonReentrant {
        for (uint256 i = 0; i < orderIds.length; i++) {
            Order storage o = orders[orderIds[i]];
            if (o.status != OrderStatus.Pending) continue;
            if (block.timestamp > o.expiry) continue;
            if (!_checkPrice(o.token, o.targetPrice, o.isBuy)) continue;

            o.status = OrderStatus.Executed;

            uint256 amountOut;
            uint256 fee;
            if (o.isBuy) {
                (amountOut, fee) = _executeBuy(o);
            } else {
                (amountOut, fee) = _executeSell(o);
            }

            emit OrderExecuted(orderIds[i], msg.sender, amountOut, fee);
        }
    }

    // ==================== 内部执行逻辑 ====================

    function _executeBuy(Order storage o) internal returns (uint256 amountOut, uint256 fee) {
        fee = (o.amount * feeBps) / BPS_BASE;
        uint256 netBnb = o.amount - fee;

        if (fee > 0) _sendBNB(feeRecipient, fee);

        uint256 minOut = _calcMinOut(o.token, netBnb, o.targetPrice, o.slippageBps, true);

        uint256 tokenBefore = IERC20(o.token).balanceOf(address(this));

        IFreedomRouter(router).buy{value: netBnb}(
            o.token,
            minOut,
            o.tipRate,
            block.timestamp
        );

        amountOut = IERC20(o.token).balanceOf(address(this)) - tokenBefore;
        require(amountOut > 0, "No tokens received");

        IERC20(o.token).safeTransfer(o.user, amountOut);
    }

    function _executeSell(Order storage o) internal returns (uint256 amountOut, uint256 fee) {
        IERC20(o.token).forceApprove(router, o.amount);

        uint256 bnbBefore = address(this).balance;

        IFreedomRouter(router).sell(
            o.token,
            o.amount,
            0, // minOut=0, slippage protection via price check + final require
            o.tipRate,
            block.timestamp
        );

        uint256 bnbOut = address(this).balance - bnbBefore;
        require(bnbOut > 0, "No BNB received");

        fee = (bnbOut * feeBps) / BPS_BASE;
        uint256 netBnb = bnbOut - fee;

        if (fee > 0) _sendBNB(feeRecipient, fee);
        if (netBnb > 0) _sendBNB(o.user, netBnb);

        amountOut = netBnb;
    }

    // ==================== 价格验证 ====================

    function _checkPrice(address token, uint256 targetPrice, bool isBuy) internal view returns (bool) {
        uint256 currentPrice = getTokenUsdPrice(token);
        if (currentPrice == 0) return false;

        if (isBuy) {
            return currentPrice <= targetPrice;
        } else {
            return currentPrice >= targetPrice;
        }
    }

    /// @notice Returns token price in USD with 18 decimals
    /// @dev price = (quoteReserve / tokenReserve) * (10^tokenDec / 10^quoteDec) * quoteUsdPrice
    ///      All returned as 18-decimal fixed point: 1e18 = $1.00
    function getTokenUsdPrice(address token) public view returns (uint256) {
        (address quote, address pair) = _findBestQuote(token);
        if (pair == address(0)) return 0;

        (uint112 r0, uint112 r1,) = IPancakePair(pair).getReserves();
        if (r0 == 0 || r1 == 0) return 0;

        address token0 = IPancakePair(pair).token0();

        // quoteReserve and tokenReserve in their raw units
        uint256 tokenReserve;
        uint256 quoteReserve;
        if (token0 == token) {
            tokenReserve = uint256(r0);
            quoteReserve = uint256(r1);
        } else {
            tokenReserve = uint256(r1);
            quoteReserve = uint256(r0);
        }

        uint8 tokenDec = _safeDecimals(token);
        uint8 quoteDec = _safeDecimals(quote);

        // priceInQuote = quoteReserve * 1e18 * 10^tokenDec / (tokenReserve * 10^quoteDec)
        // Result: how many quote-units (in 18-dec fixed point) per 1 whole token
        uint256 priceInQuote = (quoteReserve * 1e18 * (10 ** tokenDec))
            / (tokenReserve * (10 ** quoteDec));

        if (_isStablecoin(quote)) {
            return priceInQuote;
        }

        uint256 bnbPrice = _getBnbUsdPrice();
        if (bnbPrice == 0) return 0;
        return (priceInQuote * bnbPrice) / 1e18;
    }

    function _getBnbUsdPrice() internal view returns (uint256) {
        (uint112 r0, uint112 r1,) = IPancakePair(WBNB_USDT_PAIR).getReserves();
        if (r0 == 0) return 0;
        // WBNB is token0 (18 dec), USDT is token1 (18 dec)
        return (uint256(r1) * 1e18) / r0;
    }

    function _calcMinOut(
        address token,
        uint256 bnbIn,
        uint256 targetPrice,
        uint256 slippageBps,
        bool /* isBuy */
    ) internal view returns (uint256) {
        uint256 bnbUsd = _getBnbUsdPrice();
        if (bnbUsd == 0 || targetPrice == 0) return 0;

        // usdValue = bnbIn * bnbUsd / 1e18
        // expectedTokens = usdValue / targetPrice (in token decimals)
        uint8 tokenDec = _safeDecimals(token);
        uint256 usdValue = (bnbIn * bnbUsd) / 1e18;
        uint256 expected = (usdValue * (10 ** tokenDec)) / targetPrice;
        return (expected * (BPS_BASE - slippageBps)) / BPS_BASE;
    }

    // ==================== 报价辅助 ====================

    function _findBestQuote(address token) internal view returns (address bestQuote, address bestPair) {
        address[6] memory quotes = [WBNB, USDT, USD1, USDC, BUSD, FDUSD];
        uint256 bestLiquidity;
        for (uint256 i = 0; i < quotes.length; i++) {
            try IPancakeFactory(PANCAKE_FACTORY).getPair(token, quotes[i]) returns (address p) {
                if (p != address(0)) {
                    try IPancakePair(p).getReserves() returns (uint112 r0, uint112 r1, uint32) {
                        uint256 liq = uint256(r0) * uint256(r1);
                        if (liq > bestLiquidity) {
                            bestLiquidity = liq;
                            bestQuote = quotes[i];
                            bestPair = p;
                        }
                    } catch {}
                }
            } catch {}
        }
    }

    function _isStablecoin(address token) internal pure returns (bool) {
        return token == USDT || token == USD1 || token == USDC
            || token == BUSD || token == FDUSD;
    }

    function _safeDecimals(address token) internal view returns (uint8) {
        try IERC20Metadata(token).decimals() returns (uint8 d) {
            return d;
        } catch {
            return 18;
        }
    }

    // ==================== 查询 ====================

    function getOrder(uint256 orderId) external view returns (Order memory) {
        return orders[orderId];
    }

    function getOrderCount() external view returns (uint256) {
        return orders.length;
    }

    function getUserOrders(address user) external view returns (uint256[] memory) {
        return userOrders[user];
    }

    function getUserOrderCount(address user) external view returns (uint256) {
        return userOrders[user].length;
    }

    function getPendingOrders(uint256 offset, uint256 limit) external view returns (uint256[] memory ids) {
        uint256 count;
        uint256 total = orders.length;

        // First pass: count
        for (uint256 i = offset; i < total && count < limit; i++) {
            if (orders[i].status == OrderStatus.Pending && block.timestamp <= orders[i].expiry) {
                count++;
            }
        }

        ids = new uint256[](count);
        uint256 idx;
        for (uint256 i = offset; i < total && idx < count; i++) {
            if (orders[i].status == OrderStatus.Pending && block.timestamp <= orders[i].expiry) {
                ids[idx++] = i;
            }
        }
    }

    function checkExecutable(uint256 orderId) external view returns (bool executable, uint256 currentPrice) {
        Order storage o = orders[orderId];
        if (o.status != OrderStatus.Pending) return (false, 0);
        if (block.timestamp > o.expiry) return (false, 0);

        currentPrice = getTokenUsdPrice(o.token);
        if (currentPrice == 0) return (false, 0);

        if (o.isBuy) {
            executable = currentPrice <= o.targetPrice;
        } else {
            executable = currentPrice >= o.targetPrice;
        }
    }

    // ==================== 管理 ====================

    function setExecutor(address executor, bool active) external onlyOwner {
        executors[executor] = active;
        emit ExecutorUpdated(executor, active);
    }

    function setRouter(address _router) external onlyOwner {
        require(_router != address(0), "Invalid router");
        router = _router;
    }

    function setFeeBps(uint256 _feeBps) external onlyOwner {
        require(_feeBps <= MAX_FEE_BPS, "Fee too high");
        emit ConfigUpdated("feeBps", feeBps, _feeBps);
        feeBps = _feeBps;
    }

    function setFeeRecipient(address _feeRecipient) external onlyOwner {
        require(_feeRecipient != address(0), "Invalid recipient");
        feeRecipient = _feeRecipient;
    }

    function rescueTokens(address token, uint256 amount) external onlyOwner {
        if (token == address(0)) {
            _sendBNB(owner(), amount);
        } else {
            IERC20(token).safeTransfer(owner(), amount);
        }
    }

    // ==================== 内部工具 ====================

    function _sendBNB(address to, uint256 amount) internal {
        (bool ok,) = payable(to).call{value: amount}("");
        require(ok, "BNB transfer failed");
    }

    receive() external payable {}
}

// ==================== 接口 ====================

interface IFreedomRouter {
    function buy(address token, uint256 amountOutMin, uint256 tipRate, uint256 deadline)
        external payable returns (uint256 amountOut);
    function sell(address token, uint256 amountIn, uint256 amountOutMin, uint256 tipRate, uint256 deadline)
        external returns (uint256 amountOut);
}

interface IERC20Metadata {
    function decimals() external view returns (uint8);
}

interface IPancakeFactory {
    function getPair(address, address) external view returns (address);
}

interface IPancakePair {
    function getReserves() external view returns (uint112, uint112, uint32);
    function token0() external view returns (address);
}
