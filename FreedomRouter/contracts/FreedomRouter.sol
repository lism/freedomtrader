// SPDX-License-Identifier: MIT
pragma solidity ^0.8.22;

import "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import "@openzeppelin/contracts/access/Ownable.sol";
import "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import "@openzeppelin/contracts/proxy/utils/Initializable.sol";
import "@openzeppelin/contracts/proxy/utils/UUPSUpgradeable.sol";
import "@openzeppelin/contracts/proxy/ERC1967/ERC1967Proxy.sol";

/**
 * @title FreedomRouterImpl v6
 * @notice BSC 聚合路由 — Four.meme + Flap 统一入口
 *
 *   v6 changes vs v5:
 *   - UUPS 可升级代理：继承 UUPSUpgradeable，owner 可原地热升级
 *   - FLAP_DEX 降级：DEX 状态代币走 PancakeSwap 而非 Portal
 *   - nativeToQuoteSwapEnabled 门控：ERC20 quote 且未开 native swap 的 Flap 代币降级到 PancakeSwap
 *   - Pancake 外盘 tax token 兼容：用 balanceOf 差值替代原始 amountIn
 */
contract FreedomRouterImpl is Ownable, ReentrancyGuard, Initializable, UUPSUpgradeable {
    using SafeERC20 for IERC20;

    // ==================== 常量 ====================

    address public constant WBNB  = 0xbb4CdB9CBd36B01bD1cBaEBF2De08d9173bc095c;
    address public constant ETH   = 0xEeeeeEeeeEeEeeEeEeEeeEEEeeeeEeeeeeeeEEeE;
    address public constant USDT  = 0x55d398326f99059fF775485246999027B3197955;
    address public constant USD1  = 0x8d0D000Ee44948FC98c9B98A4FA4921476f08B0d;
    address public constant USDC  = 0x8AC76a51cc950d9822D68b83fE1Ad97B32Cd580d;
    address public constant BUSD  = 0xe9e7CEA3DedcA5984780Bafc599bD69ADd087D56;
    address public constant FDUSD = 0xc5f0f7b66764F6ec8C8Dff7BA683102295E16409;

    address public constant PANCAKE_FACTORY = 0xcA143Ce32Fe78f1f7019d7d551a6402fC5350c73;
    address public constant PANCAKE_ROUTER  = 0x10ED43C718714eb63d5aA57B78B54704E256024E;
    address public constant DEV = 0x2De78dd769679119b4B3a158235678df92E98319;

    uint256 public constant MAX_TIP = 500; // 5%

    // ==================== 存储 ====================

    address public tokenManagerV2;
    address public tmHelper3;
    address public flapPortal;

    // ==================== 数据结构 ====================

    enum RouteSource {
        NONE,
        FOUR_INTERNAL_BNB,
        FOUR_INTERNAL_ERC20,
        FOUR_EXTERNAL,
        FLAP_BONDING,         // bonding curve, can buy (if native-swap-ok) and sell via Portal
        FLAP_BONDING_SELL,    // bonding curve, ERC20 quote + nativeSwap disabled → sell via Portal, buy via PancakeSwap
        FLAP_DEX,             // migrated to DEX, trade via PancakeSwap (V2/V3)
        PANCAKE_ONLY
    }

    struct TokenInfo {
        string symbol;
        uint8 decimals;
        uint256 totalSupply;
        uint256 userBalance;
        // 路由信息
        RouteSource routeSource;
        address approveTarget;
        // Four.meme 状态
        uint256 mode;
        bool isInternal;
        bool tradingHalt;
        uint256 tmVersion;
        address tmAddress;
        address tmQuote;
        uint256 tmStatus;
        uint256 tmFunds;
        uint256 tmMaxFunds;
        uint256 tmOffers;
        uint256 tmMaxOffers;
        uint256 tmLastPrice;
        uint256 tmLaunchTime;
        uint256 tmTradingFeeRate;
        bool tmLiquidityAdded;
        // Flap 状态
        uint8 flapStatus;           // 0=Invalid,1=Tradable,4=DEX
        uint256 flapReserve;
        uint256 flapCirculatingSupply;
        uint256 flapPrice;
        uint8 flapTokenVersion;
        address flapQuoteToken;
        bool flapNativeSwapEnabled;
        uint256 flapTaxRate;
        address flapPool;
        uint256 flapProgress;
        // PancakeSwap 外盘
        address pair;
        address quoteToken;
        uint256 pairReserve0;
        uint256 pairReserve1;
        bool hasLiquidity;
        // TaxToken (Four)
        bool isTaxToken;
        uint256 taxFeeRate;
    }

    // ==================== 事件 ====================

    event Swap(
        address indexed sender,
        address indexed tokenIn,
        address indexed tokenOut,
        uint256 amountIn,
        uint256 amountOut,
        uint8 swapType  // 0=Four内盘买, 1=Four内盘卖, 2=Four外盘买, 3=Four外盘卖, 4=Flap买, 5=Flap卖
    );

    event ConfigUpdated(string key, address oldVal, address newVal);
    event TokensRescued(address indexed token, uint256 amount);

    // ==================== 初始化 ====================

    constructor() Ownable(msg.sender) {
        _disableInitializers();
    }

    function initialize(
        address _owner,
        address _tmV2,
        address _helper3,
        address _flapPortal
    ) external initializer {
        _transferOwnership(_owner);
        tokenManagerV2 = _tmV2;
        tmHelper3 = _helper3;
        flapPortal = _flapPortal;
    }

    // ==================== 路由检测 ====================

    function _detectRoute(address token) internal view returns (RouteSource route, address quote) {
        // 1) Four.meme 检测
        if (tmHelper3 != address(0)) {
            try IHelper3(tmHelper3).getTokenInfo(token) returns (
                uint256 ver, address _tm, address _quote,
                uint256, uint256, uint256, uint256,
                uint256, uint256, uint256, uint256,
                bool _liquidityAdded
            ) {
                if (ver > 0 && _tm != address(0)) {
                    if (_liquidityAdded) {
                        return (RouteSource.FOUR_EXTERNAL, _quote);
                    } else {
                        try IFourToken(token)._mode() returns (uint256 mode) {
                            if (mode != 0) {
                                if (_quote == address(0)) {
                                    return (RouteSource.FOUR_INTERNAL_BNB, address(0));
                                } else {
                                    return (RouteSource.FOUR_INTERNAL_ERC20, _quote);
                                }
                            }
                        } catch {}
                    }
                }
            } catch {}
        }

        // 2) Flap 检测
        if (flapPortal != address(0)) {
            try IFlapPortal(flapPortal).getTokenV7(token) returns (IFlapPortal.TokenStateV7 memory st) {
                if (st.status == 1) {
                    // nativeToQuoteSwapEnabled only gates BNB-buy direction;
                    // sell via Portal always works (outputToken = quote or address(0))
                    if (st.quoteTokenAddress == address(0) || st.nativeToQuoteSwapEnabled) {
                        return (RouteSource.FLAP_BONDING, st.quoteTokenAddress);
                    }
                    // ERC20 quote + nativeSwap disabled: sell still works via Portal, buy needs PancakeSwap
                    return (RouteSource.FLAP_BONDING_SELL, st.quoteTokenAddress);
                } else if (st.status == 4) {
                    // Portal swapExactInput currently only supports bonding curve;
                    // DEX tokens trade via PancakeSwap V2 (or V3 if migrated there)
                    (address dexQuote,) = findBestQuote(token);
                    if (dexQuote != address(0)) {
                        return (RouteSource.FLAP_DEX, dexQuote);
                    }
                    // No V2 pair found — return FLAP_DEX anyway so getTokenInfo shows correct state;
                    // buy/sell will revert with "No pair" rather than misleading "No route"
                    return (RouteSource.FLAP_DEX, st.quoteTokenAddress);
                }
            } catch {}
        }

        // 3) PancakeSwap 兜底
        (address bestQuote,) = findBestQuote(token);
        if (bestQuote != address(0)) {
            return (RouteSource.PANCAKE_ONLY, bestQuote);
        }

        return (RouteSource.NONE, address(0));
    }

    function _getApproveTarget(RouteSource route) internal view returns (address) {
        if (route == RouteSource.FOUR_INTERNAL_BNB || route == RouteSource.FOUR_INTERNAL_ERC20) {
            return tokenManagerV2;
        }
        // Flap / 外盘 / Pancake → 路由先收币再操作，approve 给路由自身
        return address(this);
    }

    function findBestQuote(address token) internal view returns (address bestQuote, address bestPair) {
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

    // ==================== 统一入口 ====================

    function buy(address token, uint256 amountOutMin, uint256 tipRate, uint256 deadline)
        external payable nonReentrant returns (uint256 amountOut)
    {
        require(block.timestamp <= deadline, "Expired");
        require(msg.value > 0, "No BNB");

        (RouteSource route,) = _detectRoute(token);
        require(route != RouteSource.NONE, "No route");

        uint256 netValue = _deductTip(msg.value, tipRate);

        if (route == RouteSource.FOUR_INTERNAL_BNB || route == RouteSource.FOUR_INTERNAL_ERC20) {
            amountOut = _buyFourInternal(token, amountOutMin, netValue);
            emit Swap(msg.sender, ETH, token, msg.value, amountOut, 0);
        } else if (route == RouteSource.FOUR_EXTERNAL || route == RouteSource.PANCAKE_ONLY
                || route == RouteSource.FLAP_DEX || route == RouteSource.FLAP_BONDING_SELL) {
            amountOut = _buyPancake(token, amountOutMin, netValue, deadline);
            emit Swap(msg.sender, ETH, token, msg.value, amountOut, 2);
        } else if (route == RouteSource.FLAP_BONDING) {
            amountOut = _buyFlap(token, amountOutMin, netValue);
            emit Swap(msg.sender, ETH, token, msg.value, amountOut, 4);
        }
        require(amountOut >= amountOutMin, "Slippage");
    }

    function sell(address token, uint256 amountIn, uint256 amountOutMin, uint256 tipRate, uint256 deadline)
        external nonReentrant returns (uint256 amountOut)
    {
        require(block.timestamp <= deadline, "Expired");

        (RouteSource route,) = _detectRoute(token);
        require(route != RouteSource.NONE, "No route");

        if (route == RouteSource.FOUR_INTERNAL_BNB || route == RouteSource.FOUR_INTERNAL_ERC20) {
            amountOut = _sellFourInternal(token, amountIn, amountOutMin, tipRate);
            emit Swap(msg.sender, token, ETH, amountIn, amountOut, 1);
        } else if (route == RouteSource.FOUR_EXTERNAL || route == RouteSource.PANCAKE_ONLY || route == RouteSource.FLAP_DEX) {
            amountOut = _sellPancakeCompat(token, amountIn, tipRate, deadline);
            emit Swap(msg.sender, token, ETH, amountIn, amountOut, 3);
        } else if (route == RouteSource.FLAP_BONDING || route == RouteSource.FLAP_BONDING_SELL) {
            amountOut = _sellFlap(token, amountIn, amountOutMin, tipRate);
            emit Swap(msg.sender, token, ETH, amountIn, amountOut, 5);
        }
        require(amountOut >= amountOutMin, "Slippage");
    }

    // ==================== Four 内盘买入 ====================

    function _buyFourInternal(address token, uint256 amountOutMin, uint256 value) internal returns (uint256) {
        (uint256 ver, address tm, address quote,) = _getTokenTMInfo(token);
        require(ver > 0 && tm != address(0), "No TM");

        uint256 before = IERC20(token).balanceOf(msg.sender);

        if (quote == address(0)) {
            ITMV2(tm).buyTokenAMAP{value: value}(token, msg.sender, value, amountOutMin);
        } else {
            require(tmHelper3 != address(0), "No Helper3");
            uint256 quoteBefore = IERC20(quote).balanceOf(address(this));
            uint256 ethBefore = address(this).balance;
            IHelper3(tmHelper3).buyWithEth{value: value}(0, token, msg.sender, value, amountOutMin);
            _refundBaseline(quote, quoteBefore, ethBefore, msg.sender);
        }

        return IERC20(token).balanceOf(msg.sender) - before;
    }

    // ==================== Four 内盘卖出 ====================

    function _sellFourInternal(address token, uint256 amountIn, uint256 amountOutMin, uint256 tipRate) internal returns (uint256) {
        (uint256 ver, address tm, address quote,) = _getTokenTMInfo(token);
        require(ver > 0 && tm != address(0), "No TM");
        uint256 rate = tipRate <= MAX_TIP ? tipRate : MAX_TIP;

        if (quote == address(0)) {
            uint256 bnbBefore = msg.sender.balance;
            ITMV2(tm).sellToken(0, token, msg.sender, amountIn, amountOutMin, rate, DEV);
            uint256 bnbAfter = msg.sender.balance;
            return bnbAfter > bnbBefore ? bnbAfter - bnbBefore : 0;
        } else {
            require(tmHelper3 != address(0), "No Helper3");
            uint256 quoteBefore = IERC20(quote).balanceOf(address(this));
            uint256 ethBefore = address(this).balance;
            uint256 bnbBefore = msg.sender.balance;
            IHelper3(tmHelper3).sellForEth(0, token, msg.sender, amountIn, 0, rate, DEV);
            _refundBaseline(quote, quoteBefore, ethBefore, msg.sender);
            uint256 bnbAfter = msg.sender.balance;
            return bnbAfter > bnbBefore ? bnbAfter - bnbBefore : 0;
        }
    }

    // ==================== Flap 买入 ====================

    function _buyFlap(address token, uint256 amountOutMin, uint256 value) internal returns (uint256) {
        require(flapPortal != address(0), "No Flap Portal");

        uint256 userBefore = IERC20(token).balanceOf(msg.sender);
        uint256 routerTokenBefore = IERC20(token).balanceOf(address(this));
        uint256 ethBeforeSwap = address(this).balance - value;

        IFlapPortal(flapPortal).swapExactInput{value: value}(
            IFlapPortal.ExactInputParams({
                inputToken: address(0),
                outputToken: token,
                inputAmount: value,
                minOutputAmount: amountOutMin,
                permitData: ""
            })
        );

        uint256 routerGain = IERC20(token).balanceOf(address(this)) - routerTokenBefore;
        if (routerGain > 0) {
            IERC20(token).safeTransfer(msg.sender, routerGain);
        }
        uint256 ethAfter = address(this).balance;
        if (ethAfter > ethBeforeSwap) {
            _sendBNB(msg.sender, ethAfter - ethBeforeSwap);
        }

        return IERC20(token).balanceOf(msg.sender) - userBefore;
    }

    // ==================== Flap 卖出 ====================

    function _sellFlap(address token, uint256 amountIn, uint256 amountOutMin, uint256 tipRate) internal returns (uint256) {
        require(flapPortal != address(0), "No Flap Portal");

        uint256 balBefore = IERC20(token).balanceOf(address(this));
        IERC20(token).safeTransferFrom(msg.sender, address(this), amountIn);
        uint256 actualIn = IERC20(token).balanceOf(address(this)) - balBefore;

        IERC20(token).forceApprove(flapPortal, actualIn);

        uint256 bnbBefore = address(this).balance;

        IFlapPortal(flapPortal).swapExactInput(
            IFlapPortal.ExactInputParams({
                inputToken: token,
                outputToken: address(0),
                inputAmount: actualIn,
                minOutputAmount: amountOutMin,
                permitData: ""
            })
        );

        uint256 bnbOut = address(this).balance - bnbBefore;
        uint256 tip = _calcTip(bnbOut, tipRate);
        if (tip > 0) _sendBNB(DEV, tip);
        uint256 net = bnbOut - tip;
        if (net > 0) _sendBNB(msg.sender, net);
        return net;
    }

    // ==================== PancakeSwap ====================

    function _buyPancake(address token, uint256 amountOutMin, uint256 value, uint256 dl) internal returns (uint256) {
        (address quote,) = findBestQuote(token);

        address[] memory path;
        if (quote == WBNB || quote == address(0)) {
            path = new address[](2);
            path[0] = WBNB;
            path[1] = token;
        } else {
            path = new address[](3);
            path[0] = WBNB;
            path[1] = quote;
            path[2] = token;
        }

        uint256 balBefore = IERC20(token).balanceOf(msg.sender);
        try IPancakeRouter(PANCAKE_ROUTER)
            .swapExactETHForTokensSupportingFeeOnTransferTokens{value: value}(
                amountOutMin, path, msg.sender, dl
            )
        {} catch {
            IPancakeRouter(PANCAKE_ROUTER)
                .swapExactETHForTokens{value: value}(amountOutMin, path, msg.sender, dl);
        }
        return IERC20(token).balanceOf(msg.sender) - balBefore;
    }

    /// @dev Tax-token compatible: transfer in, measure actual balance, swap actual amount
    function _sellPancakeCompat(address token, uint256 amountIn, uint256 tipRate, uint256 dl) internal returns (uint256) {
        uint256 balBefore = IERC20(token).balanceOf(address(this));
        IERC20(token).safeTransferFrom(msg.sender, address(this), amountIn);
        uint256 actualIn = IERC20(token).balanceOf(address(this)) - balBefore;

        IERC20(token).forceApprove(PANCAKE_ROUTER, actualIn);
        (address quote,) = findBestQuote(token);

        address[] memory path;
        if (quote == WBNB || quote == address(0)) {
            path = new address[](2);
            path[0] = token;
            path[1] = WBNB;
        } else {
            path = new address[](3);
            path[0] = token;
            path[1] = quote;
            path[2] = WBNB;
        }

        uint256 bnbBefore = address(this).balance;
        try IPancakeRouter(PANCAKE_ROUTER)
            .swapExactTokensForETHSupportingFeeOnTransferTokens(
                actualIn, 0, path, address(this), dl
            )
        {} catch {
            IPancakeRouter(PANCAKE_ROUTER)
                .swapExactTokensForETH(actualIn, 0, path, address(this), dl);
        }
        uint256 bnbOut = address(this).balance - bnbBefore;

        uint256 tip = _calcTip(bnbOut, tipRate);
        if (tip > 0) _sendBNB(DEV, tip);
        uint256 net = bnbOut - tip;
        if (net > 0) _sendBNB(msg.sender, net);
        return net;
    }

    // ==================== 基线退款（替代旧 _sweepResidue）====================

    function _refundBaseline(address quote, uint256 quoteBefore, uint256 ethBefore, address to) internal {
        uint256 quoteNow = IERC20(quote).balanceOf(address(this));
        if (quoteNow > quoteBefore) {
            IERC20(quote).safeTransfer(to, quoteNow - quoteBefore);
        }
        uint256 ethNow = address(this).balance;
        if (ethNow > ethBefore) {
            _sendBNB(to, ethNow - ethBefore);
        }
    }

    // ==================== 统一报价 ====================

    function quoteBuy(address token, uint256 amountIn) external returns (uint256 amountOut) {
        require(msg.sender == address(0) || tx.origin == address(0), "eth_call only");
        (RouteSource route,) = _detectRoute(token);
        require(route != RouteSource.NONE, "No route");

        if (route == RouteSource.FOUR_INTERNAL_BNB || route == RouteSource.FOUR_INTERNAL_ERC20) {
            require(tmHelper3 != address(0), "No Helper3");
            (,, uint256 estimated,,,,,) = IHelper3(tmHelper3).tryBuy(token, 0, amountIn);
            return estimated;
        } else if (route == RouteSource.FLAP_BONDING) {
            require(flapPortal != address(0), "No Flap");
            return IFlapPortal(flapPortal).quoteExactInput(
                IFlapPortal.QuoteExactInputParams({
                    inputToken: address(0),
                    outputToken: token,
                    inputAmount: amountIn
                })
            );
        } else {
            // FOUR_EXTERNAL / PANCAKE_ONLY / FLAP_DEX / FLAP_BONDING_SELL → PancakeSwap 报价
            (address bestQuote,) = findBestQuote(token);
            address[] memory path;
            if (bestQuote == WBNB || bestQuote == address(0)) {
                path = new address[](2);
                path[0] = WBNB;
                path[1] = token;
            } else {
                path = new address[](3);
                path[0] = WBNB;
                path[1] = bestQuote;
                path[2] = token;
            }
            uint256[] memory amounts = IPancakeRouter(PANCAKE_ROUTER).getAmountsOut(amountIn, path);
            return amounts[amounts.length - 1];
        }
    }

    function quoteSell(address token, uint256 amountIn) external returns (uint256 amountOut) {
        require(msg.sender == address(0) || tx.origin == address(0), "eth_call only");
        (RouteSource route, address quote) = _detectRoute(token);
        require(route != RouteSource.NONE, "No route");

        if (route == RouteSource.FOUR_INTERNAL_BNB || route == RouteSource.FOUR_INTERNAL_ERC20) {
            require(tmHelper3 != address(0), "No Helper3");
            (,,uint256 funds, uint256 fee) = IHelper3(tmHelper3).trySell(token, amountIn);
            uint256 netQuote = funds > fee ? funds - fee : 0;
            if (netQuote == 0) return 0;
            if (route == RouteSource.FOUR_INTERNAL_ERC20 && quote != address(0)) {
                address[] memory path = new address[](2);
                path[0] = quote;
                path[1] = WBNB;
                try IPancakeRouter(PANCAKE_ROUTER).getAmountsOut(netQuote, path) returns (uint256[] memory amounts) {
                    return amounts[1];
                } catch {
                    return 0;
                }
            }
            return netQuote;
        } else if (route == RouteSource.FLAP_BONDING || route == RouteSource.FLAP_BONDING_SELL) {
            require(flapPortal != address(0), "No Flap");
            return IFlapPortal(flapPortal).quoteExactInput(
                IFlapPortal.QuoteExactInputParams({
                    inputToken: token,
                    outputToken: address(0),
                    inputAmount: amountIn
                })
            );
        } else {
            // FOUR_EXTERNAL / PANCAKE_ONLY / FLAP_DEX → PancakeSwap 报价
            (address bestQuote,) = findBestQuote(token);
            address[] memory path;
            if (bestQuote == WBNB || bestQuote == address(0)) {
                path = new address[](2);
                path[0] = token;
                path[1] = WBNB;
            } else {
                path = new address[](3);
                path[0] = token;
                path[1] = bestQuote;
                path[2] = WBNB;
            }
            uint256[] memory amounts = IPancakeRouter(PANCAKE_ROUTER).getAmountsOut(amountIn, path);
            return amounts[amounts.length - 1];
        }
    }

    // ==================== 查询 ====================

    function _getTokenTMInfo(address token) internal view returns (
        uint256 version, address tm, address quote, bool liquidityAdded
    ) {
        if (tmHelper3 == address(0)) return (0, address(0), address(0), false);
        try IHelper3(tmHelper3).getTokenInfo(token) returns (
            uint256 v, address _tm, address _quote,
            uint256, uint256, uint256, uint256,
            uint256, uint256, uint256, uint256,
            bool _liquidityAdded
        ) {
            return (v, _tm, _quote, _liquidityAdded);
        } catch {
            return (0, address(0), address(0), false);
        }
    }

    function _getTokenInfo(address token, address user) internal view returns (TokenInfo memory info) {
        // 基础 ERC20
        try IERC20Metadata(token).symbol() returns (string memory s) { info.symbol = s; } catch {}
        try IERC20Metadata(token).decimals() returns (uint8 d) { info.decimals = d; } catch { info.decimals = 18; }
        try IERC20(token).totalSupply() returns (uint256 ts) { info.totalSupply = ts; } catch {}
        if (user != address(0)) {
            try IERC20(token).balanceOf(user) returns (uint256 b) { info.userBalance = b; } catch {}
        }

        // Four.meme
        try IFourToken(token)._mode() returns (uint256 m) { info.mode = m; } catch {}
        try IFourToken(token)._tradingHalt() returns (bool h) { info.tradingHalt = h; } catch {}

        if (tmHelper3 != address(0)) {
            try IHelper3(tmHelper3).getTokenInfo(token) returns (
                uint256 ver, address _tm, address _quote,
                uint256 lastPrice, uint256 tradingFeeRate, uint256,
                uint256 launchTime, uint256 offers, uint256 maxOffers,
                uint256 funds, uint256 maxFunds, bool liqAdded
            ) {
                info.tmVersion = ver;
                info.tmAddress = _tm;
                info.tmQuote = _quote;
                info.tmLastPrice = lastPrice;
                info.tmTradingFeeRate = tradingFeeRate;
                info.tmLaunchTime = launchTime;
                info.tmOffers = offers;
                info.tmMaxOffers = maxOffers;
                info.tmFunds = funds;
                info.tmMaxFunds = maxFunds;
                info.tmLiquidityAdded = liqAdded;
                info.isInternal = info.mode != 0 && ver > 0 && !liqAdded;
            } catch {}
        }

        // TaxToken (Four) 检测
        if (info.tmVersion == 2 && tokenManagerV2 != address(0)) {
            try ITMQuery(tokenManagerV2)._tokenInfos(token) returns (ITMQuery.TMInfo memory tmInfo) {
                uint256 creatorType = (tmInfo.template >> 10) & 0x3F;
                info.isTaxToken = (creatorType == 5);
                info.tmStatus = tmInfo.status;
            } catch {}
            if (info.isTaxToken) {
                try ITaxToken(token).feeRate() returns (uint256 fr) {
                    info.taxFeeRate = fr;
                } catch {}
            }
        }

        // Flap 检测
        if (flapPortal != address(0) && info.tmVersion == 0) {
            try IFlapPortal(flapPortal).getTokenV7(token) returns (IFlapPortal.TokenStateV7 memory st) {
                info.flapStatus = uint8(st.status);
                info.flapReserve = st.reserve;
                info.flapCirculatingSupply = st.circulatingSupply;
                info.flapPrice = st.price;
                info.flapTokenVersion = uint8(st.tokenVersion);
                info.flapQuoteToken = st.quoteTokenAddress;
                info.flapNativeSwapEnabled = st.nativeToQuoteSwapEnabled;
                info.flapTaxRate = st.taxRate;
                info.flapPool = st.pool;
                info.flapProgress = st.progress;
            } catch {}
        }

        // PancakeSwap 外盘
        (address bestQuote, address bestPair) = findBestQuote(token);
        info.quoteToken = bestQuote;
        info.pair = bestPair;
        if (bestPair != address(0)) {
            try IPancakePair(bestPair).getReserves() returns (uint112 r0, uint112 r1, uint32) {
                info.pairReserve0 = r0;
                info.pairReserve1 = r1;
                info.hasLiquidity = (r0 > 0 && r1 > 0);
            } catch {}
        }

        // 计算 routeSource 和 approveTarget
        (RouteSource route,) = _detectRoute(token);
        info.routeSource = route;
        info.approveTarget = _getApproveTarget(route);
    }

    function getTokenInfo(address token, address user) external view returns (TokenInfo memory) {
        return _getTokenInfo(token, user);
    }

    // ==================== 小费 ====================

    function _calcTip(uint256 amount, uint256 tipRate) internal pure returns (uint256) {
        if (tipRate == 0) return 0;
        uint256 rate = tipRate <= MAX_TIP ? tipRate : MAX_TIP;
        return amount * rate / 10000;
    }

    function _deductTip(uint256 amount, uint256 tipRate) internal returns (uint256) {
        uint256 tip = _calcTip(amount, tipRate);
        if (tip > 0) _sendBNB(DEV, tip);
        return amount - tip;
    }

    function _sendBNB(address to, uint256 amount) internal {
        (bool ok, ) = payable(to).call{value: amount}("");
        require(ok, "BNB transfer failed");
    }

    // ==================== 管理 ====================

    function setTokenManagerV2(address a) external onlyOwner {
        emit ConfigUpdated("tmV2", tokenManagerV2, a);
        tokenManagerV2 = a;
    }

    function setHelper3(address a) external onlyOwner {
        emit ConfigUpdated("helper3", tmHelper3, a);
        tmHelper3 = a;
    }

    function setFlapPortal(address a) external onlyOwner {
        emit ConfigUpdated("flapPortal", flapPortal, a);
        flapPortal = a;
    }

    function rescueTokens(address token, uint256 amount) external onlyOwner {
        if (token == ETH) {
            uint256 bal = address(this).balance;
            uint256 toSend = amount > bal ? bal : amount;
            _sendBNB(owner(), toSend);
        } else {
            IERC20(token).safeTransfer(owner(), amount);
        }
        emit TokensRescued(token, amount);
    }

    // ==================== UUPS 升级 ====================

    function _authorizeUpgrade(address) internal override onlyOwner {}

    receive() external payable {}
}

// ==================== Proxy ====================

contract FreedomRouter is ERC1967Proxy {
    constructor(address impl, bytes memory data) ERC1967Proxy(impl, data) {}
}

// ==================== 接口 ====================

interface IERC20Metadata {
    function symbol() external view returns (string memory);
    function decimals() external view returns (uint8);
}

interface IFourToken {
    function _mode() external view returns (uint256);
    function _tradingHalt() external view returns (bool);
}

interface ITaxToken {
    function feeRate() external view returns (uint256);
}

interface ITMV2 {
    function buyTokenAMAP(address token, address to, uint256 funds, uint256 minAmount) external payable;
    function sellToken(uint256 origin, address token, address from, uint256 amount, uint256 minFunds, uint256 feeRate, address feeRecipient) external;
}

interface IHelper3 {
    function getTokenInfo(address token) external view returns (
        uint256 version, address tokenManager, address quote,
        uint256 lastPrice, uint256 tradingFeeRate, uint256 minTradingFee,
        uint256 launchTime, uint256 offers, uint256 maxOffers,
        uint256 funds, uint256 maxFunds, bool liquidityAdded
    );
    function buyWithEth(uint256 origin, address token, address to, uint256 funds, uint256 minAmount) external payable;
    function sellForEth(uint256 origin, address token, address from, uint256 amount, uint256 minFunds, uint256 feeRate, address feeRecipient) external;
    function tryBuy(address token, uint256 amount, uint256 funds) external view returns (
        address tokenManager, address quote, uint256 estimatedAmount, uint256 estimatedCost,
        uint256 estimatedFee, uint256 amountMsgValue, uint256 amountApproval, uint256 amountFunds
    );
    function trySell(address token, uint256 amount) external view returns (
        address tokenManager, address quote, uint256 funds, uint256 fee
    );
}

interface ITMQuery {
    struct TMInfo {
        address base; address quote; uint256 template; uint256 totalSupply;
        uint256 maxOffers; uint256 maxRaising; uint256 launchTime;
        uint256 offers; uint256 funds; uint256 lastPrice; uint256 K; uint256 T; uint256 status;
    }
    function _tokenInfos(address token) external view returns (TMInfo memory);
}

interface IFlapPortal {
    struct TokenStateV7 {
        uint8 status;
        uint256 reserve;
        uint256 circulatingSupply;
        uint256 price;
        uint8 tokenVersion;
        uint256 r;
        uint256 h;
        uint256 k;
        uint256 dexSupplyThresh;
        address quoteTokenAddress;
        bool nativeToQuoteSwapEnabled;
        bytes32 extensionID;
        uint256 taxRate;
        address pool;
        uint256 progress;
        uint8 lpFeeProfile;
        uint8 dexId;
    }

    struct QuoteExactInputParams {
        address inputToken;
        address outputToken;
        uint256 inputAmount;
    }

    struct ExactInputParams {
        address inputToken;
        address outputToken;
        uint256 inputAmount;
        uint256 minOutputAmount;
        bytes permitData;
    }

    function getTokenV7(address token) external view returns (TokenStateV7 memory);
    function quoteExactInput(QuoteExactInputParams calldata params) external returns (uint256 outputAmount);
    function swapExactInput(ExactInputParams calldata params) external payable returns (uint256 outputAmount);
}

interface IPancakeFactory { function getPair(address, address) external view returns (address); }
interface IPancakePair { function getReserves() external view returns (uint112, uint112, uint32); }

interface IPancakeRouter {
    function swapExactETHForTokens(uint256, address[] calldata, address, uint256) external payable returns (uint256[] memory);
    function swapExactTokensForETH(uint256, uint256, address[] calldata, address, uint256) external returns (uint256[] memory);
    function swapExactETHForTokensSupportingFeeOnTransferTokens(uint256, address[] calldata, address, uint256) external payable;
    function swapExactTokensForETHSupportingFeeOnTransferTokens(uint256, uint256, address[] calldata, address, uint256) external;
    function getAmountsOut(uint256, address[] calldata) external view returns (uint256[] memory);
}
