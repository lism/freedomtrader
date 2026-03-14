// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {PoolKey} from "infinity-core/src/types/PoolKey.sol";
import {PoolId, PoolIdLibrary} from "infinity-core/src/types/PoolId.sol";
import {Currency, CurrencyLibrary} from "infinity-core/src/types/Currency.sol";
import {BalanceDelta} from "infinity-core/src/types/BalanceDelta.sol";
import {BeforeSwapDelta, BeforeSwapDeltaLibrary} from "infinity-core/src/types/BeforeSwapDelta.sol";
import {ICLPoolManager} from "infinity-core/src/pool-cl/interfaces/ICLPoolManager.sol";
import {IHooks} from "infinity-core/src/interfaces/IHooks.sol";
import {CLPoolParametersHelper} from "infinity-core/src/pool-cl/libraries/CLPoolParametersHelper.sol";
import {TickMath} from "infinity-core/src/pool-cl/libraries/TickMath.sol";
import {CurrencySettlement} from "infinity-core/test/helpers/CurrencySettlement.sol";
import {IERC20Minimal} from "infinity-core/src/interfaces/IERC20Minimal.sol";
import {CLBaseHook} from "bsc-hook/src/pool-cl/CLBaseHook.sol";

// ─── Epoch type ───────────────────────────────────────────────────────────────
type Epoch is uint232;

using {epochEquals as ==} for Epoch global;

function epochEquals(Epoch a, Epoch b) pure returns (bool) {
    return Epoch.unwrap(a) == Epoch.unwrap(b);
}

library EpochLibrary {
    function unsafeIncrement(Epoch self) internal pure returns (Epoch) {
        unchecked {
            return Epoch.wrap(Epoch.unwrap(self) + 1);
        }
    }
}

// ─── Direction enum ───────────────────────────────────────────────────────────
enum Direction {
    Both,
    BuyOnly,
    SellOnly
}

/// @title FreedomHook
/// @notice PancakeSwap Infinity CL Hook combining:
///   1. Limit orders via single-sided LP with epoch-based fill tracking
///   2. Configurable directional restriction (buy-only / sell-only / both)
///   3. Convenience createPool()
contract FreedomHook is CLBaseHook {
    using PoolIdLibrary for PoolKey;
    using CLPoolParametersHelper for bytes32;
    using CurrencySettlement for Currency;
    using CurrencyLibrary for Currency;
    using EpochLibrary for Epoch;

    // ─── Errors ───────────────────────────────────────────────────────────────
    error ZeroLiquidity();
    error InRange();
    error CrossedRange();
    error Filled();
    error NotFilled();
    error NotOwner();
    error DirectionBlocked();
    error EpochNotInitialized();

    // ─── Events ───────────────────────────────────────────────────────────────
    event LimitOrderPlaced(
        PoolId indexed poolId, int24 tickLower, bool zeroForOne, address owner, uint128 liquidity, Epoch epoch
    );
    event LimitOrderKilled(
        PoolId indexed poolId, int24 tickLower, bool zeroForOne, address owner, uint128 liquidity
    );
    event LimitOrderFilled(PoolId indexed poolId, int24 tickLower, bool zeroForOne, Epoch epoch);
    event LimitOrderWithdrawn(Epoch indexed epoch, address to, uint256 amount0, uint256 amount1);
    event DirectionSet(PoolId indexed poolId, Direction direction);

    // ─── Structs ──────────────────────────────────────────────────────────────
    struct EpochInfo {
        bool filled;
        Currency token0;
        Currency token1;
        uint256 token0Total;
        uint256 token1Total;
        uint128 liquidityTotal;
        mapping(address => uint128) liquidity;
    }

    // ─── State ────────────────────────────────────────────────────────────────
    Epoch public epochCounter;
    address public owner;

    mapping(PoolId => int24) public tickLowerLasts;
    mapping(bytes32 => Epoch) public epochs;
    mapping(Epoch => EpochInfo) public epochInfos;
    mapping(PoolId => Direction) public directionConfigs;

    int24 public constant TICK_SPACING = 1;
    uint24 public constant POOL_FEE = 100; // 0.01%

    // ─── Constructor ──────────────────────────────────────────────────────────
    constructor(ICLPoolManager _poolManager, address _owner) CLBaseHook(_poolManager) {
        owner = _owner;
        epochCounter = Epoch.wrap(1);
    }

    modifier onlyOwner() {
        if (msg.sender != owner) revert NotOwner();
        _;
    }

    // ─── Hook bitmap ──────────────────────────────────────────────────────────
    function getHooksRegistrationBitmap() external pure override returns (uint16) {
        return _hooksRegistrationBitmapFrom(
            Permissions({
                beforeInitialize: false,
                afterInitialize: true,
                beforeAddLiquidity: false,
                afterAddLiquidity: false,
                beforeRemoveLiquidity: false,
                afterRemoveLiquidity: false,
                beforeSwap: true,
                afterSwap: true,
                beforeDonate: false,
                afterDonate: false,
                beforeSwapReturnDelta: false,
                afterSwapReturnDelta: false,
                afterAddLiquidityReturnDelta: false,
                afterRemoveLiquidityReturnDelta: false
            })
        );
    }

    // ═══════════════════════════════════════════════════════════════════════════
    //  Hook callbacks
    // ═══════════════════════════════════════════════════════════════════════════

    function _afterInitialize(address, PoolKey calldata key, uint160, int24 tick)
        internal
        override
        returns (bytes4)
    {
        _setTickLowerLast(key.toId(), _getTickLower(tick, TICK_SPACING));
        return this.afterInitialize.selector;
    }

    function _beforeSwap(
        address,
        PoolKey calldata key,
        ICLPoolManager.SwapParams calldata params,
        bytes calldata
    ) internal view override returns (bytes4, BeforeSwapDelta, uint24) {
        Direction dir = directionConfigs[key.toId()];
        if (dir == Direction.BuyOnly && params.zeroForOne) revert DirectionBlocked();
        if (dir == Direction.SellOnly && !params.zeroForOne) revert DirectionBlocked();
        return (this.beforeSwap.selector, BeforeSwapDeltaLibrary.ZERO_DELTA, 0);
    }

    function _afterSwap(
        address,
        PoolKey calldata key,
        ICLPoolManager.SwapParams calldata params,
        BalanceDelta,
        bytes calldata
    ) internal override returns (bytes4, int128) {
        (int24 tickAfter,) = _getSlot0(key);
        int24 currentLower = _getTickLower(tickAfter, TICK_SPACING);
        int24 lastLower = tickLowerLasts[key.toId()];

        if (currentLower != lastLower) {
            int24 lower;
            int24 upper;
            if (currentLower < lastLower) {
                lower = currentLower + TICK_SPACING;
                upper = lastLower;
            } else {
                lower = lastLower;
                upper = currentLower - TICK_SPACING;
            }

            for (int24 tick = lower; tick <= upper; tick += TICK_SPACING) {
                _tryFillEpoch(key, tick, params.zeroForOne);
            }

            _setTickLowerLast(key.toId(), currentLower);
        }

        return (this.afterSwap.selector, 0);
    }

    // ═══════════════════════════════════════════════════════════════════════════
    //  Limit order: place / kill / withdraw
    // ═══════════════════════════════════════════════════════════════════════════

    function place(PoolKey calldata key, int24 tickLower, bool zeroForOne, uint128 liquidity)
        external
    {
        if (liquidity == 0) revert ZeroLiquidity();

        (int24 currentTick,) = _getSlot0(key);
        int24 currentLower = _getTickLower(currentTick, TICK_SPACING);

        if (zeroForOne) {
            if (tickLower >= currentLower) revert InRange();
        } else {
            if (tickLower < currentLower + TICK_SPACING) revert InRange();
        }

        Epoch epoch = _getOrCreateEpoch(key, tickLower, zeroForOne);
        EpochInfo storage info = epochInfos[epoch];
        if (info.filled) revert Filled();

        info.token0 = key.currency0;
        info.token1 = key.currency1;
        info.liquidity[msg.sender] += liquidity;
        info.liquidityTotal += liquidity;

        int24 tickUpper = tickLower + TICK_SPACING;

        vault.lock(
            abi.encodeCall(this._addLiquidityCallback, (key, tickLower, tickUpper, int256(uint256(liquidity)), msg.sender))
        );

        emit LimitOrderPlaced(key.toId(), tickLower, zeroForOne, msg.sender, liquidity, epoch);
    }

    function kill(PoolKey calldata key, int24 tickLower, bool zeroForOne, address to)
        external
    {
        Epoch epoch = _getEpoch(key, tickLower, zeroForOne);
        if (Epoch.unwrap(epoch) == 0) revert EpochNotInitialized();

        EpochInfo storage info = epochInfos[epoch];
        if (info.filled) revert Filled();

        uint128 liq = info.liquidity[msg.sender];
        if (liq == 0) revert ZeroLiquidity();

        delete info.liquidity[msg.sender];
        info.liquidityTotal -= liq;

        int24 tickUpper = tickLower + TICK_SPACING;

        vault.lock(
            abi.encodeCall(this._removeLiquidityCallback, (key, tickLower, tickUpper, int256(uint256(liq)), to))
        );

        emit LimitOrderKilled(key.toId(), tickLower, zeroForOne, msg.sender, liq);
    }

    function withdraw(Epoch epoch, address to) external {
        EpochInfo storage info = epochInfos[epoch];
        if (!info.filled) revert NotFilled();

        uint128 liq = info.liquidity[msg.sender];
        if (liq == 0) revert ZeroLiquidity();
        delete info.liquidity[msg.sender];

        uint256 amount0 = (uint256(info.token0Total) * liq) / info.liquidityTotal;
        uint256 amount1 = (uint256(info.token1Total) * liq) / info.liquidityTotal;

        if (amount0 > 0) {
            IERC20Minimal(Currency.unwrap(info.token0)).transfer(to, amount0);
        }
        if (amount1 > 0) {
            IERC20Minimal(Currency.unwrap(info.token1)).transfer(to, amount1);
        }

        emit LimitOrderWithdrawn(epoch, to, amount0, amount1);
    }

    // ═══════════════════════════════════════════════════════════════════════════
    //  Direction config
    // ═══════════════════════════════════════════════════════════════════════════

    function setDirection(PoolKey calldata key, Direction dir) external onlyOwner {
        directionConfigs[key.toId()] = dir;
        emit DirectionSet(key.toId(), dir);
    }

    // ═══════════════════════════════════════════════════════════════════════════
    //  Pool creation convenience
    // ═══════════════════════════════════════════════════════════════════════════

    function createPool(address tokenA, address tokenB, uint160 sqrtPriceX96) external returns (PoolId) {
        (Currency c0, Currency c1) = _sortCurrencies(tokenA, tokenB);

        PoolKey memory key = PoolKey({
            currency0: c0,
            currency1: c1,
            hooks: IHooks(address(this)),
            poolManager: poolManager,
            fee: POOL_FEE,
            parameters: bytes32(uint256(this.getHooksRegistrationBitmap())).setTickSpacing(TICK_SPACING)
        });

        poolManager.initialize(key, sqrtPriceX96);
        return key.toId();
    }

    // ═══════════════════════════════════════════════════════════════════════════
    //  Vault lock callbacks (called via vault.lock → lockAcquired → self.call)
    // ═══════════════════════════════════════════════════════════════════════════

    function _addLiquidityCallback(
        PoolKey calldata key,
        int24 tickLower,
        int24 tickUpper,
        int256 liquidityDelta,
        address payer
    ) external selfOnly {
        (BalanceDelta delta,) = poolManager.modifyLiquidity(
            key,
            ICLPoolManager.ModifyLiquidityParams({
                tickLower: tickLower,
                tickUpper: tickUpper,
                liquidityDelta: liquidityDelta,
                salt: bytes32(0)
            }),
            ""
        );

        if (delta.amount0() < 0) {
            key.currency0.settle(vault, payer, uint256(uint128(-delta.amount0())), false);
        }
        if (delta.amount1() < 0) {
            key.currency1.settle(vault, payer, uint256(uint128(-delta.amount1())), false);
        }
        if (delta.amount0() > 0) {
            key.currency0.take(vault, address(this), uint256(uint128(delta.amount0())), false);
        }
        if (delta.amount1() > 0) {
            key.currency1.take(vault, address(this), uint256(uint128(delta.amount1())), false);
        }
    }

    function _removeLiquidityCallback(
        PoolKey calldata key,
        int24 tickLower,
        int24 tickUpper,
        int256 liquidityDelta,
        address recipient
    ) external selfOnly {
        (BalanceDelta delta,) = poolManager.modifyLiquidity(
            key,
            ICLPoolManager.ModifyLiquidityParams({
                tickLower: tickLower,
                tickUpper: tickUpper,
                liquidityDelta: -liquidityDelta,
                salt: bytes32(0)
            }),
            ""
        );

        if (delta.amount0() > 0) {
            key.currency0.take(vault, recipient, uint256(uint128(delta.amount0())), false);
        }
        if (delta.amount1() > 0) {
            key.currency1.take(vault, recipient, uint256(uint128(delta.amount1())), false);
        }
    }

    function _fillOrderCallback(
        PoolKey calldata key,
        int24 tickLower,
        int24 tickUpper,
        int256 liquidityDelta
    ) external selfOnly returns (BalanceDelta delta) {
        (delta,) = poolManager.modifyLiquidity(
            key,
            ICLPoolManager.ModifyLiquidityParams({
                tickLower: tickLower,
                tickUpper: tickUpper,
                liquidityDelta: -liquidityDelta,
                salt: bytes32(0)
            }),
            ""
        );

        if (delta.amount0() > 0) {
            key.currency0.take(vault, address(this), uint256(uint128(delta.amount0())), false);
        }
        if (delta.amount1() > 0) {
            key.currency1.take(vault, address(this), uint256(uint128(delta.amount1())), false);
        }
    }

    // ═══════════════════════════════════════════════════════════════════════════
    //  Internal helpers
    // ═══════════════════════════════════════════════════════════════════════════

    function _tryFillEpoch(PoolKey calldata key, int24 tick, bool zeroForOne) internal {
        bytes32 epochKey = _epochKey(key, tick, zeroForOne);
        Epoch epoch = epochs[epochKey];
        if (Epoch.unwrap(epoch) == 0) return;

        EpochInfo storage info = epochInfos[epoch];
        if (info.filled || info.liquidityTotal == 0) return;

        int24 tickUpper = tick + TICK_SPACING;

        bytes memory result = vault.lock(
            abi.encodeCall(this._fillOrderCallback, (key, tick, tickUpper, int256(uint256(info.liquidityTotal))))
        );

        BalanceDelta delta = abi.decode(result, (BalanceDelta));

        info.filled = true;
        if (delta.amount0() > 0) info.token0Total = uint256(uint128(delta.amount0()));
        if (delta.amount1() > 0) info.token1Total = uint256(uint128(delta.amount1()));

        epochs[epochKey] = Epoch.wrap(0);

        emit LimitOrderFilled(key.toId(), tick, zeroForOne, epoch);
    }

    function _getOrCreateEpoch(PoolKey calldata key, int24 tickLower, bool zeroForOne)
        internal
        returns (Epoch epoch)
    {
        bytes32 k = _epochKey(key, tickLower, zeroForOne);
        epoch = epochs[k];
        if (Epoch.unwrap(epoch) == 0) {
            epoch = epochCounter;
            epochs[k] = epoch;
            epochCounter = epoch.unsafeIncrement();
        }
    }

    function _getEpoch(PoolKey calldata key, int24 tickLower, bool zeroForOne)
        internal
        view
        returns (Epoch)
    {
        return epochs[_epochKey(key, tickLower, zeroForOne)];
    }

    function _epochKey(PoolKey calldata key, int24 tickLower, bool zeroForOne)
        internal
        pure
        returns (bytes32)
    {
        return keccak256(abi.encode(key.toId(), tickLower, zeroForOne));
    }

    function _getSlot0(PoolKey calldata key) internal view returns (int24 tick, uint160 sqrtPrice) {
        (sqrtPrice, tick,,) = poolManager.getSlot0(key.toId());
    }

    function _getTickLower(int24 tick, int24 tickSpacing) internal pure returns (int24) {
        int24 compressed = tick / tickSpacing;
        if (tick < 0 && tick % tickSpacing != 0) compressed--;
        return compressed * tickSpacing;
    }

    function _setTickLowerLast(PoolId poolId, int24 tickLower) internal {
        tickLowerLasts[poolId] = tickLower;
    }

    function _sortCurrencies(address tokenA, address tokenB)
        internal
        pure
        returns (Currency c0, Currency c1)
    {
        if (tokenA < tokenB) {
            c0 = Currency.wrap(tokenA);
            c1 = Currency.wrap(tokenB);
        } else {
            c0 = Currency.wrap(tokenB);
            c1 = Currency.wrap(tokenA);
        }
    }

    // ═══════════════════════════════════════════════════════════════════════════
    //  View helpers
    // ═══════════════════════════════════════════════════════════════════════════

    function getEpoch(PoolKey calldata key, int24 tickLower, bool zeroForOne)
        external
        view
        returns (Epoch)
    {
        return _getEpoch(key, tickLower, zeroForOne);
    }

    function getEpochLiquidity(Epoch epoch, address user) external view returns (uint128) {
        return epochInfos[epoch].liquidity[user];
    }

    function isEpochFilled(Epoch epoch) external view returns (bool) {
        return epochInfos[epoch].filled;
    }
}
