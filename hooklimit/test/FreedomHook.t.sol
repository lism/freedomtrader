// SPDX-License-Identifier: UNLICENSED
pragma solidity ^0.8.24;

import {Test} from "forge-std/Test.sol";
import {MockERC20} from "solmate/src/test/utils/mocks/MockERC20.sol";
import {Currency} from "infinity-core/src/types/Currency.sol";
import {PoolKey} from "infinity-core/src/types/PoolKey.sol";
import {PoolId, PoolIdLibrary} from "infinity-core/src/types/PoolId.sol";
import {CLPoolParametersHelper} from "infinity-core/src/pool-cl/libraries/CLPoolParametersHelper.sol";
import {TickMath} from "infinity-core/src/pool-cl/libraries/TickMath.sol";
import {Constants} from "infinity-core/test/pool-cl/helpers/Constants.sol";
import {ICLRouterBase} from "infinity-periphery/src/pool-cl/interfaces/ICLRouterBase.sol";
import {CLTestUtils} from "bsc-hook/test/pool-cl/utils/CLTestUtils.sol";

import {FreedomHook, Epoch, Direction} from "../src/FreedomHook.sol";

contract FreedomHookTest is Test, CLTestUtils {
    using PoolIdLibrary for PoolKey;
    using CLPoolParametersHelper for bytes32;

    FreedomHook hook;
    Currency currency0;
    Currency currency1;
    PoolKey key;

    address alice = makeAddr("alice");
    address bob = makeAddr("bob");

    // With TICK_SPACING=1, liquidity maps to token amounts via very tight ranges.
    // 1e18 liquidity across 1 tick ≈ 5e13 token units, so we keep mints generous.
    uint128 constant LIQ = 1e12;

    function setUp() public {
        (currency0, currency1) = deployContractsWithTokens();
        hook = new FreedomHook(poolManager, address(this));

        key = PoolKey({
            currency0: currency0,
            currency1: currency1,
            hooks: hook,
            poolManager: poolManager,
            fee: hook.POOL_FEE(),
            parameters: bytes32(uint256(hook.getHooksRegistrationBitmap())).setTickSpacing(hook.TICK_SPACING())
        });

        poolManager.initialize(key, Constants.SQRT_RATIO_1_1);

        MockERC20(Currency.unwrap(currency0)).mint(address(this), 1000 ether);
        MockERC20(Currency.unwrap(currency1)).mint(address(this), 1000 ether);
        addLiquidity(key, 100 ether, 100 ether, -120, 120, address(this));

        _setupUser(alice);
        _setupUser(bob);
    }

    function _setupUser(address user) internal {
        MockERC20(Currency.unwrap(currency0)).mint(user, 100 ether);
        MockERC20(Currency.unwrap(currency1)).mint(user, 100 ether);
        permit2Approve(user, currency0, address(universalRouter));
        permit2Approve(user, currency1, address(universalRouter));

        vm.startPrank(user);
        MockERC20(Currency.unwrap(currency0)).approve(address(vault), type(uint256).max);
        MockERC20(Currency.unwrap(currency1)).approve(address(vault), type(uint256).max);
        MockERC20(Currency.unwrap(currency0)).approve(address(hook), type(uint256).max);
        MockERC20(Currency.unwrap(currency1)).approve(address(hook), type(uint256).max);
        vm.stopPrank();
    }

    // ═══════════════════════════════════════════════════════════════════════════
    //  Place + withdraw (basic limit order lifecycle)
    // ═══════════════════════════════════════════════════════════════════════════

    function test_PlaceLimitOrder_ZeroForOne() public {
        int24 tickLower = -2;

        vm.prank(alice);
        hook.place(key, tickLower, true, LIQ);

        Epoch epoch = hook.getEpoch(key, tickLower, true);
        assertGt(Epoch.unwrap(epoch), 0, "epoch should be created");
        assertEq(hook.getEpochLiquidity(epoch, alice), LIQ, "alice liq recorded");
        assertFalse(hook.isEpochFilled(epoch), "not filled yet");
    }

    function test_PlaceLimitOrder_OneForZero() public {
        int24 tickLower = 1;

        vm.prank(alice);
        hook.place(key, tickLower, false, LIQ);

        Epoch epoch = hook.getEpoch(key, tickLower, false);
        assertGt(Epoch.unwrap(epoch), 0);
    }

    function test_PlaceRevert_InRange() public {
        vm.prank(alice);
        vm.expectRevert();
        hook.place(key, 0, true, LIQ);
    }

    function test_PlaceRevert_ZeroLiquidity() public {
        vm.prank(alice);
        vm.expectRevert();
        hook.place(key, -2, true, 0);
    }

    // ═══════════════════════════════════════════════════════════════════════════
    //  Kill (cancel)
    // ═══════════════════════════════════════════════════════════════════════════

    function test_KillLimitOrder() public {
        int24 tickLower = -2;

        vm.prank(alice);
        hook.place(key, tickLower, true, LIQ);

        Epoch epoch = hook.getEpoch(key, tickLower, true);

        uint256 bal0Before = MockERC20(Currency.unwrap(currency0)).balanceOf(alice);
        uint256 bal1Before = MockERC20(Currency.unwrap(currency1)).balanceOf(alice);

        vm.prank(alice);
        hook.kill(key, tickLower, true, alice);

        assertEq(hook.getEpochLiquidity(epoch, alice), 0, "liq cleared");
        uint256 bal0After = MockERC20(Currency.unwrap(currency0)).balanceOf(alice);
        uint256 bal1After = MockERC20(Currency.unwrap(currency1)).balanceOf(alice);
        assertTrue(bal0After > bal0Before || bal1After > bal1Before, "tokens returned");
    }

    // ═══════════════════════════════════════════════════════════════════════════
    //  Fill via swap + withdraw
    // ═══════════════════════════════════════════════════════════════════════════

    function test_FillAndWithdraw() public {
        int24 tickLower = -2;

        vm.prank(alice);
        hook.place(key, tickLower, true, LIQ);

        Epoch epoch = hook.getEpoch(key, tickLower, true);

        uint256 bal0Before = MockERC20(Currency.unwrap(currency0)).balanceOf(alice);
        uint256 bal1Before = MockERC20(Currency.unwrap(currency1)).balanceOf(alice);

        vm.prank(bob, bob);
        exactInputSingle(
            ICLRouterBase.CLSwapExactInputSingleParams({
                poolKey: key,
                zeroForOne: true,
                amountIn: 5 ether,
                amountOutMinimum: 0,
                hookData: ""
            })
        );

        assertTrue(hook.isEpochFilled(epoch), "epoch should be filled after swap");

        vm.prank(alice);
        hook.withdraw(epoch, alice);

        uint256 bal0After = MockERC20(Currency.unwrap(currency0)).balanceOf(alice);
        uint256 bal1After = MockERC20(Currency.unwrap(currency1)).balanceOf(alice);
        assertTrue(bal0After > bal0Before || bal1After > bal1Before, "alice should receive tokens from filled order");
        assertEq(hook.getEpochLiquidity(epoch, alice), 0, "liq withdrawn");
    }

    function test_WithdrawRevert_NotFilled() public {
        int24 tickLower = -2;

        vm.prank(alice);
        hook.place(key, tickLower, true, LIQ);

        Epoch epoch = hook.getEpoch(key, tickLower, true);

        vm.prank(alice);
        vm.expectRevert();
        hook.withdraw(epoch, alice);
    }

    // ═══════════════════════════════════════════════════════════════════════════
    //  Multiple users in same epoch
    // ═══════════════════════════════════════════════════════════════════════════

    function test_MultipleUsersShareEpoch() public {
        int24 tickLower = -2;

        vm.prank(alice);
        hook.place(key, tickLower, true, LIQ);

        vm.prank(bob);
        hook.place(key, tickLower, true, LIQ);

        Epoch epoch = hook.getEpoch(key, tickLower, true);
        assertEq(hook.getEpochLiquidity(epoch, alice), LIQ);
        assertEq(hook.getEpochLiquidity(epoch, bob), LIQ);

        vm.prank(alice, alice);
        exactInputSingle(
            ICLRouterBase.CLSwapExactInputSingleParams({
                poolKey: key,
                zeroForOne: true,
                amountIn: 10 ether,
                amountOutMinimum: 0,
                hookData: ""
            })
        );

        assertTrue(hook.isEpochFilled(epoch));

        uint256 aliceBal0Before = MockERC20(Currency.unwrap(currency0)).balanceOf(alice);
        uint256 aliceBal1Before = MockERC20(Currency.unwrap(currency1)).balanceOf(alice);
        uint256 bobBal0Before = MockERC20(Currency.unwrap(currency0)).balanceOf(bob);
        uint256 bobBal1Before = MockERC20(Currency.unwrap(currency1)).balanceOf(bob);

        vm.prank(alice);
        hook.withdraw(epoch, alice);

        vm.prank(bob);
        hook.withdraw(epoch, bob);

        uint256 aliceGot0 = MockERC20(Currency.unwrap(currency0)).balanceOf(alice) - aliceBal0Before;
        uint256 aliceGot1 = MockERC20(Currency.unwrap(currency1)).balanceOf(alice) - aliceBal1Before;
        uint256 bobGot0 = MockERC20(Currency.unwrap(currency0)).balanceOf(bob) - bobBal0Before;
        uint256 bobGot1 = MockERC20(Currency.unwrap(currency1)).balanceOf(bob) - bobBal1Before;

        assertEq(aliceGot0, bobGot0, "equal liquidity should get equal token0 payout");
        assertEq(aliceGot1, bobGot1, "equal liquidity should get equal token1 payout");
    }

    // ═══════════════════════════════════════════════════════════════════════════
    //  Direction restriction
    // ═══════════════════════════════════════════════════════════════════════════

    function test_DirectionBuyOnly() public {
        hook.setDirection(key, Direction.BuyOnly);

        vm.prank(alice, alice);
        vm.expectRevert();
        exactInputSingle(
            ICLRouterBase.CLSwapExactInputSingleParams({
                poolKey: key,
                zeroForOne: true,
                amountIn: 0.1 ether,
                amountOutMinimum: 0,
                hookData: ""
            })
        );

        vm.prank(alice, alice);
        exactInputSingle(
            ICLRouterBase.CLSwapExactInputSingleParams({
                poolKey: key,
                zeroForOne: false,
                amountIn: 0.1 ether,
                amountOutMinimum: 0,
                hookData: ""
            })
        );
    }

    function test_DirectionSellOnly() public {
        hook.setDirection(key, Direction.SellOnly);

        vm.prank(alice, alice);
        vm.expectRevert();
        exactInputSingle(
            ICLRouterBase.CLSwapExactInputSingleParams({
                poolKey: key,
                zeroForOne: false,
                amountIn: 0.1 ether,
                amountOutMinimum: 0,
                hookData: ""
            })
        );

        vm.prank(alice, alice);
        exactInputSingle(
            ICLRouterBase.CLSwapExactInputSingleParams({
                poolKey: key,
                zeroForOne: true,
                amountIn: 0.1 ether,
                amountOutMinimum: 0,
                hookData: ""
            })
        );
    }

    function test_SetDirectionRevert_NotOwner() public {
        vm.prank(alice);
        vm.expectRevert();
        hook.setDirection(key, Direction.SellOnly);
    }

    // ═══════════════════════════════════════════════════════════════════════════
    //  createPool convenience
    // ═══════════════════════════════════════════════════════════════════════════

    function test_CreatePool() public {
        MockERC20 tokenX = new MockERC20("X", "X", 18);
        MockERC20 tokenY = new MockERC20("Y", "Y", 18);

        PoolId id = hook.createPool(address(tokenX), address(tokenY), Constants.SQRT_RATIO_1_1);
        assertTrue(PoolId.unwrap(id) != bytes32(0), "pool created");
    }
}
