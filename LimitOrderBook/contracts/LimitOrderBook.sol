// SPDX-License-Identifier: MIT
pragma solidity ^0.8.22;

import "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import "@openzeppelin/contracts/access/Ownable.sol";
import "@openzeppelin/contracts/utils/Create2.sol";
import "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import "@openzeppelin/contracts/utils/structs/EnumerableSet.sol";

import "./OrderVault.sol";

/**
 * @title LimitOrderBook
 * @notice Entry contract for limit orders. User assets are escrowed in a
 *         dedicated vault per user; the book only tracks order state.
 */
contract LimitOrderBook is Ownable, ReentrancyGuard {
    using SafeERC20 for IERC20;
    using EnumerableSet for EnumerableSet.UintSet;
    using EnumerableSet for EnumerableSet.AddressSet;

    // ==================== Constants ====================

    address public constant WBNB  = 0xbb4CdB9CBd36B01bD1cBaEBF2De08d9173bc095c;
    address public constant USDT  = 0x55d398326f99059fF775485246999027B3197955;
    address public constant USD1  = 0x8d0D000Ee44948FC98c9B98A4FA4921476f08B0d;
    address public constant USDC  = 0x8AC76a51cc950d9822D68b83fE1Ad97B32Cd580d;
    address public constant BUSD  = 0xe9e7CEA3DedcA5984780Bafc599bD69ADd087D56;
    address public constant FDUSD = 0xc5f0f7b66764F6ec8C8Dff7BA683102295E16409;

    address public constant PANCAKE_FACTORY = 0xcA143Ce32Fe78f1f7019d7d551a6402fC5350c73;
    address public constant WBNB_USDT_PAIR  = 0x16b9a82891338f9bA80E2D6970FddA79D1eb0daE;

    uint256 public constant MAX_FEE_BPS = 500;
    uint256 public constant BPS_BASE = 10000;
    uint256 public constant MAX_SLIPPAGE_BPS = 5000;
    uint256 public constant MAX_ROUTER_TIP_BPS = 500;

    uint256 private constant ROUTE_FOUR_INTERNAL_BNB = 1;
    uint256 private constant ROUTE_FOUR_INTERNAL_ERC20 = 2;
    bytes32 private constant VAULT_SALT_DOMAIN = keccak256("FreedomTrader.OrderVault");

    // ==================== Storage ====================

    address public router;
    uint256 public feeBps;
    address public feeRecipient;

    mapping(address => bool) public executors;
    mapping(address => address) public userVaults;
    mapping(uint256 => address) public orderVaults;
    mapping(address => uint256) public reservedNativeByVault;
    mapping(address => mapping(address => uint256)) private _reservedTokenByVault;

    // ==================== Data Structures ====================

    enum OrderStatus { Pending, Executed, Cancelled, Expired }

    struct Order {
        address user;
        address token;
        bool isBuy;
        uint256 amount;
        uint256 targetPrice;
        uint256 slippageBps;
        uint256 tipRate;
        uint256 expiry;
        OrderStatus status;
    }

    Order[] public orders;
    mapping(address => uint256[]) public userOrders;

    // ==================== EnumerableSet Indexes ====================

    EnumerableSet.UintSet private _allPending;
    mapping(address => EnumerableSet.UintSet) private _pendingByToken;
    EnumerableSet.AddressSet private _activeTokens;

    // ==================== Events ====================

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

    event OrderFailed(uint256 indexed orderId);
    event OrderCancelled(uint256 indexed orderId);
    event OrderExpired(uint256 indexed orderId);
    event ExecutorUpdated(address indexed executor, bool active);
    event ConfigUpdated(string key, uint256 oldVal, uint256 newVal);
    event VaultCreated(address indexed user, address indexed vault);
    event VaultReservationUpdated(address indexed vault, address indexed asset, uint256 reservedAmount);

    // ==================== Modifiers ====================

    modifier onlyExecutor() {
        require(executors[msg.sender], "Not executor");
        _;
    }

    // ==================== Constructor ====================

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

    // ==================== Create Orders ====================

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
        _requireSupportedCustody(token);

        address vault = _ensureVault(msg.sender);
        OrderVault(payable(vault)).depositNative{value: msg.value}();

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
        orderVaults[orderId] = vault;
        userOrders[msg.sender].push(orderId);

        _reserveOrderEscrow(vault, true, token, msg.value);
        _addPending(orderId, token);

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
        _requireSupportedCustody(token);

        address vault = _ensureVault(msg.sender);
        uint256 balBefore = IERC20(token).balanceOf(vault);
        IERC20(token).safeTransferFrom(msg.sender, vault, amount);
        uint256 actualAmount = IERC20(token).balanceOf(vault) - balBefore;
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
        orderVaults[orderId] = vault;
        userOrders[msg.sender].push(orderId);

        _reserveOrderEscrow(vault, false, token, actualAmount);
        _addPending(orderId, token);

        emit OrderCreated(orderId, msg.sender, token, false, actualAmount, targetPrice, expiry);
    }

    // ==================== Cancel ====================

    function cancelOrder(uint256 orderId) external nonReentrant {
        Order storage o = orders[orderId];
        require(o.user == msg.sender, "Not owner");
        require(o.status == OrderStatus.Pending, "Not pending");

        address vault = _requireOrderVault(orderId);

        o.status = OrderStatus.Cancelled;
        _removePending(orderId, o.token);
        _releaseOrderEscrow(vault, o.isBuy, o.token, o.amount);

        if (o.isBuy) {
            OrderVault(payable(vault)).sendNative(o.user, o.amount);
        } else {
            OrderVault(payable(vault)).sendToken(o.token, o.user, o.amount);
        }

        emit OrderCancelled(orderId);
    }

    // ==================== Claim Expired ====================

    function claimExpired(uint256 orderId) external nonReentrant {
        Order storage o = orders[orderId];
        require(o.status == OrderStatus.Pending, "Not pending");
        require(block.timestamp > o.expiry, "Not expired");

        address vault = _requireOrderVault(orderId);

        o.status = OrderStatus.Expired;
        _removePending(orderId, o.token);
        _releaseOrderEscrow(vault, o.isBuy, o.token, o.amount);

        if (o.isBuy) {
            OrderVault(payable(vault)).sendNative(o.user, o.amount);
        } else {
            OrderVault(payable(vault)).sendToken(o.token, o.user, o.amount);
        }

        emit OrderExpired(orderId);
    }

    // ==================== Execute: Safe Mode (with on-chain price check) ====================

    function executeOrder(uint256 orderId) external onlyExecutor nonReentrant returns (uint256 amountOut) {
        Order storage o = orders[orderId];
        require(o.status == OrderStatus.Pending, "Not pending");
        require(block.timestamp <= o.expiry, "Expired");
        require(_checkPrice(o.token, o.targetPrice, o.isBuy), "Price not met");

        address vault = _requireOrderVault(orderId);

        o.status = OrderStatus.Executed;
        _removePending(orderId, o.token);
        _releaseOrderEscrow(vault, o.isBuy, o.token, o.amount);

        uint256 fee;
        if (o.isBuy) {
            (amountOut, fee) = _executeBuy(o, vault);
        } else {
            (amountOut, fee) = _executeSell(o, vault);
        }

        emit OrderExecuted(orderId, msg.sender, amountOut, fee);
    }

    // ==================== Batch Execute ====================

    function batchExecute(uint256[] calldata orderIds) external onlyExecutor nonReentrant {
        for (uint256 i = 0; i < orderIds.length; i++) {
            Order storage o = orders[orderIds[i]];
            if (o.status != OrderStatus.Pending) continue;
            if (block.timestamp > o.expiry) continue;
            if (!_checkPrice(o.token, o.targetPrice, o.isBuy)) continue;

            try this._executeOrder(orderIds[i]) returns (uint256 amountOut, uint256 fee) {
                emit OrderExecuted(orderIds[i], msg.sender, amountOut, fee);
            } catch {
                emit OrderFailed(orderIds[i]);
            }
        }
    }

    /**
     * @dev External wrapper for try/catch (internal functions can't be try-caught).
     *      Only callable by the contract itself.
     */
    function _executeOrder(uint256 orderId) external returns (uint256 amountOut, uint256 fee) {
        require(msg.sender == address(this), "Self only");

        Order storage o = orders[orderId];
        require(o.status == OrderStatus.Pending, "Not pending");
        require(block.timestamp <= o.expiry, "Expired");
        require(_checkPrice(o.token, o.targetPrice, o.isBuy), "Price not met");

        address vault = _requireOrderVault(orderId);

        o.status = OrderStatus.Executed;
        _removePending(orderId, o.token);
        _releaseOrderEscrow(vault, o.isBuy, o.token, o.amount);

        if (o.isBuy) {
            (amountOut, fee) = _executeBuy(o, vault);
        } else {
            (amountOut, fee) = _executeSell(o, vault);
        }
    }

    // ==================== Internal Execution ====================

    function _executeBuy(Order storage o, address vault) internal returns (uint256 amountOut, uint256 fee) {
        fee = (o.amount * feeBps) / BPS_BASE;
        uint256 netBnb = o.amount - fee;
        uint256 swapBnb = netBnb - _calcRouterTip(netBnb, o.tipRate);

        if (fee > 0) {
            OrderVault(payable(vault)).sendNative(feeRecipient, fee);
        }

        uint256 minOut = _calcBuyMinOut(o.token, swapBnb, o.targetPrice, o.slippageBps);
        uint256 tokenBefore = IERC20(o.token).balanceOf(vault);
        address beneficiary = o.user;

        OrderVault(payable(vault)).routerBuy(
            router,
            o.token,
            minOut,
            o.tipRate,
            block.timestamp,
            netBnb
        );

        amountOut = IERC20(o.token).balanceOf(vault) - tokenBefore;
        require(amountOut > 0, "No tokens received");

        OrderVault(payable(vault)).sendToken(o.token, beneficiary, amountOut);
    }

    function _executeSell(Order storage o, address vault) internal returns (uint256 amountOut, uint256 fee) {
        uint256 minOut = _calcSellMinOut(o.token, o.amount, o.targetPrice, o.slippageBps);
        uint256 bnbBefore = vault.balance;
        address beneficiary = o.user;

        OrderVault(payable(vault)).routerSell(
            router,
            o.token,
            o.amount,
            minOut,
            o.tipRate,
            block.timestamp
        );

        uint256 bnbOut = vault.balance - bnbBefore;
        require(bnbOut > 0, "No BNB received");

        fee = (bnbOut * feeBps) / BPS_BASE;
        uint256 netBnb = bnbOut - fee;

        if (fee > 0) {
            OrderVault(payable(vault)).sendNative(feeRecipient, fee);
        }
        if (netBnb > 0) {
            OrderVault(payable(vault)).sendNative(beneficiary, netBnb);
        }

        amountOut = netBnb;
    }

    // ==================== Price Verification ====================

    function _checkPrice(address token, uint256 targetPrice, bool isBuy) internal view returns (bool) {
        uint256 currentPrice = getTokenUsdPrice(token);
        if (currentPrice == 0) return false;

        if (isBuy) {
            return currentPrice <= targetPrice;
        }
        return currentPrice >= targetPrice;
    }

    function getTokenUsdPrice(address token) public view returns (uint256) {
        (address quote, address pair) = _findBestQuote(token);
        if (pair == address(0)) return 0;

        (uint112 r0, uint112 r1,) = IPancakePair(pair).getReserves();
        if (r0 == 0 || r1 == 0) return 0;

        address token0 = IPancakePair(pair).token0();

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

        uint256 priceInQuote = (quoteReserve * 1e18 * (10 ** uint256(tokenDec)))
            / (tokenReserve * (10 ** uint256(quoteDec)));

        if (_isStablecoin(quote)) {
            return priceInQuote;
        }

        uint256 bnbPrice = _getBnbUsdPrice();
        if (bnbPrice == 0) return 0;
        return (priceInQuote * bnbPrice) / 1e18;
    }

    function _getBnbUsdPrice() internal view returns (uint256) {
        (uint112 r0, uint112 r1,) = IPancakePair(WBNB_USDT_PAIR).getReserves();
        if (r0 == 0 || r1 == 0) return 0;

        address token0 = IPancakePair(WBNB_USDT_PAIR).token0();
        uint256 wbnbReserve;
        uint256 usdtReserve;
        if (token0 == WBNB) {
            wbnbReserve = uint256(r0);
            usdtReserve = uint256(r1);
        } else {
            wbnbReserve = uint256(r1);
            usdtReserve = uint256(r0);
        }

        uint8 wbnbDec = _safeDecimals(WBNB);
        uint8 usdtDec = _safeDecimals(USDT);
        return (usdtReserve * 1e18 * (10 ** uint256(wbnbDec)))
            / (wbnbReserve * (10 ** uint256(usdtDec)));
    }

    function _calcBuyMinOut(
        address token,
        uint256 bnbIn,
        uint256 targetPrice,
        uint256 slippageBps
    ) internal view returns (uint256) {
        uint256 bnbUsd = _getBnbUsdPrice();
        if (bnbUsd == 0 || targetPrice == 0) return 0;

        uint8 tokenDec = _safeDecimals(token);
        uint256 usdValue = (bnbIn * bnbUsd) / 1e18;
        uint256 expected = (usdValue * (10 ** uint256(tokenDec))) / targetPrice;
        return (expected * (BPS_BASE - slippageBps)) / BPS_BASE;
    }

    function _calcSellMinOut(
        address token,
        uint256 tokenAmount,
        uint256 targetPrice,
        uint256 slippageBps
    ) internal view returns (uint256) {
        uint256 bnbUsd = _getBnbUsdPrice();
        if (bnbUsd == 0 || targetPrice == 0) return 0;

        uint8 tokenDec = _safeDecimals(token);
        uint256 usdValue = (tokenAmount * targetPrice) / (10 ** uint256(tokenDec));
        uint256 expectedBnb = (usdValue * 1e18) / bnbUsd;
        return (expectedBnb * (BPS_BASE - slippageBps)) / BPS_BASE;
    }

    // ==================== Quote Helpers ====================

    function _findBestQuote(address token) internal view returns (address bestQuote, address bestPair) {
        address[6] memory quotes = [WBNB, USDT, USD1, USDC, BUSD, FDUSD];
        uint256 bestLiquidity;
        for (uint256 i = 0; i < quotes.length; i++) {
            try IPancakeFactory(PANCAKE_FACTORY).getPair(token, quotes[i]) returns (address pair) {
                if (pair == address(0)) continue;

                try IPancakePair(pair).getReserves() returns (uint112 r0, uint112 r1, uint32) {
                    uint256 liquidity = uint256(r0) * uint256(r1);
                    if (liquidity > bestLiquidity) {
                        bestLiquidity = liquidity;
                        bestQuote = quotes[i];
                        bestPair = pair;
                    }
                } catch {}
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

    // ==================== Vault Helpers ====================

    function vaultSalt(address user) public pure returns (bytes32) {
        return keccak256(abi.encode(VAULT_SALT_DOMAIN, user));
    }

    function predictVault(address user) public view returns (address) {
        bytes32 salt = vaultSalt(user);
        bytes32 bytecodeHash = keccak256(
            abi.encodePacked(type(OrderVault).creationCode, abi.encode(user, address(this)))
        );
        return Create2.computeAddress(salt, bytecodeHash);
    }

    function getUserVault(address user) external view returns (address vault, bool deployed) {
        vault = userVaults[user];
        if (vault != address(0)) {
            return (vault, true);
        }
        return (predictVault(user), false);
    }

    function reservedTokenByVault(address vault, address token) external view returns (uint256) {
        return _reservedTokenByVault[vault][token];
    }

    function availableNativeByVault(address vault) external view returns (uint256) {
        uint256 reserved = reservedNativeByVault[vault];
        uint256 balance = vault.balance;
        return balance > reserved ? balance - reserved : 0;
    }

    function availableTokenByVault(address vault, address token) external view returns (uint256) {
        uint256 reserved = _reservedTokenByVault[vault][token];
        uint256 balance = IERC20(token).balanceOf(vault);
        return balance > reserved ? balance - reserved : 0;
    }

    function getOrderEscrow(uint256 orderId)
        external
        view
        returns (address vault, address asset, uint256 amount, address beneficiary, bool pending)
    {
        Order storage o = orders[orderId];
        vault = orderVaults[orderId];
        asset = _escrowAsset(o.isBuy, o.token);
        amount = o.amount;
        beneficiary = o.user;
        pending = (o.status == OrderStatus.Pending);
    }

    function _ensureVault(address user) internal returns (address vault) {
        vault = userVaults[user];
        if (vault != address(0)) return vault;

        bytes32 salt = vaultSalt(user);
        vault = predictVault(user);
        if (vault.code.length == 0) {
            vault = address(new OrderVault{salt: salt}(user, address(this)));
        }
        userVaults[user] = vault;
        emit VaultCreated(user, vault);
    }

    function _requireOrderVault(uint256 orderId) internal view returns (address vault) {
        vault = orderVaults[orderId];
        require(vault != address(0), "Vault missing");
    }

    function _reserveOrderEscrow(address vault, bool isBuy, address token, uint256 amount) internal {
        address asset = _escrowAsset(isBuy, token);
        if (asset == address(0)) {
            reservedNativeByVault[vault] += amount;
            emit VaultReservationUpdated(vault, address(0), reservedNativeByVault[vault]);
        } else {
            _reservedTokenByVault[vault][asset] += amount;
            emit VaultReservationUpdated(vault, asset, _reservedTokenByVault[vault][asset]);
        }
    }

    function _releaseOrderEscrow(address vault, bool isBuy, address token, uint256 amount) internal {
        address asset = _escrowAsset(isBuy, token);
        if (asset == address(0)) {
            uint256 reserved = reservedNativeByVault[vault];
            require(reserved >= amount, "Reserved native underflow");
            unchecked {
                reservedNativeByVault[vault] = reserved - amount;
            }
            emit VaultReservationUpdated(vault, address(0), reservedNativeByVault[vault]);
        } else {
            uint256 reserved = _reservedTokenByVault[vault][asset];
            require(reserved >= amount, "Reserved token underflow");
            unchecked {
                _reservedTokenByVault[vault][asset] = reserved - amount;
            }
            emit VaultReservationUpdated(vault, asset, _reservedTokenByVault[vault][asset]);
        }
    }

    function _escrowAsset(bool isBuy, address token) internal pure returns (address) {
        return isBuy ? address(0) : token;
    }

    // ==================== EnumerableSet Index Management ====================

    function _addPending(uint256 orderId, address token) internal {
        _allPending.add(orderId);
        _pendingByToken[token].add(orderId);
        _activeTokens.add(token);
    }

    function _removePending(uint256 orderId, address token) internal {
        _allPending.remove(orderId);
        _pendingByToken[token].remove(orderId);
        if (_pendingByToken[token].length() == 0) {
            _activeTokens.remove(token);
        }
    }

    // ==================== Keeper Query Interface ====================

    function getPendingByToken(address token, uint256 offset, uint256 limit)
        external view returns (uint256[] memory ids)
    {
        uint256 total = _pendingByToken[token].length();
        if (offset >= total) return new uint256[](0);

        uint256 end = offset + limit;
        if (end > total) end = total;
        ids = new uint256[](end - offset);
        for (uint256 i = offset; i < end; i++) {
            ids[i - offset] = _pendingByToken[token].at(i);
        }
    }

    function getPendingCountByToken(address token) external view returns (uint256) {
        return _pendingByToken[token].length();
    }

    function getPendingCount() external view returns (uint256) {
        return _allPending.length();
    }

    function getAllPending(uint256 offset, uint256 limit)
        external view returns (uint256[] memory ids)
    {
        uint256 total = _allPending.length();
        if (offset >= total) return new uint256[](0);

        uint256 end = offset + limit;
        if (end > total) end = total;
        ids = new uint256[](end - offset);
        for (uint256 i = offset; i < end; i++) {
            ids[i - offset] = _allPending.at(i);
        }
    }

    function allPendingTokens() external view returns (address[] memory tokens) {
        uint256 len = _activeTokens.length();
        tokens = new address[](len);
        for (uint256 i = 0; i < len; i++) {
            tokens[i] = _activeTokens.at(i);
        }
    }

    function activeTokenCount() external view returns (uint256) {
        return _activeTokens.length();
    }

    // ==================== Legacy Query ====================

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

    // ==================== Admin ====================

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

    /**
     * @dev Rescue only touches balances accidentally sent to the entry book.
     *      User escrow lives in per-user vaults and is out of scope here.
     */
    function rescueTokens(address token, uint256 amount) external onlyOwner {
        if (token == address(0)) {
            require(address(this).balance >= amount, "Insufficient balance");
            _sendBNB(owner(), amount);
        } else {
            require(IERC20(token).balanceOf(address(this)) >= amount, "Insufficient balance");
            IERC20(token).safeTransfer(owner(), amount);
        }
    }

    // ==================== Internal Helpers ====================

    function _calcRouterTip(uint256 amount, uint256 tipRate) internal pure returns (uint256) {
        if (tipRate == 0) return 0;
        uint256 rate = tipRate <= MAX_ROUTER_TIP_BPS ? tipRate : MAX_ROUTER_TIP_BPS;
        return (amount * rate) / BPS_BASE;
    }

    function _requireSupportedCustody(address token) internal view {
        (bool ok, bytes memory data) = router.staticcall(
            abi.encodeWithSignature("getTokenInfo(address,address)", token, address(this))
        );
        require(ok && data.length >= 192, "Router info unavailable");

        uint256 routeSource;
        assembly {
            routeSource := mload(add(data, 192))
        }

        require(
            routeSource != ROUTE_FOUR_INTERNAL_BNB && routeSource != ROUTE_FOUR_INTERNAL_ERC20,
            "Unsupported custody route"
        );
    }

    function _sendBNB(address to, uint256 amount) internal {
        (bool ok,) = payable(to).call{value: amount}("");
        require(ok, "BNB transfer failed");
    }

    receive() external payable {}
}

// ==================== Interfaces ====================

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
