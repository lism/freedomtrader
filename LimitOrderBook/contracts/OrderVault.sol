// SPDX-License-Identifier: MIT
pragma solidity ^0.8.22;

import "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";

interface IVaultRouter {
    function buy(address token, uint256 amountOutMin, uint256 tipRate, uint256 deadline)
        external payable returns (uint256 amountOut);
    function sell(address token, uint256 amountIn, uint256 amountOutMin, uint256 tipRate, uint256 deadline)
        external returns (uint256 amountOut);
}

contract OrderVault {
    using SafeERC20 for IERC20;

    address public immutable owner;
    address public immutable orderBook;

    modifier onlyOrderBook() {
        require(msg.sender == orderBook, "Not order book");
        _;
    }

    constructor(address owner_, address orderBook_) {
        require(owner_ != address(0), "Invalid owner");
        require(orderBook_ != address(0), "Invalid order book");
        owner = owner_;
        orderBook = orderBook_;
    }

    function depositNative() external payable onlyOrderBook {}

    function sendNative(address to, uint256 amount) external onlyOrderBook {
        (bool ok,) = payable(to).call{value: amount}("");
        require(ok, "Native transfer failed");
    }

    function sendToken(address token, address to, uint256 amount) external onlyOrderBook {
        IERC20(token).safeTransfer(to, amount);
    }

    function routerBuy(
        address router,
        address token,
        uint256 amountOutMin,
        uint256 tipRate,
        uint256 deadline,
        uint256 value
    ) external onlyOrderBook returns (uint256 amountOut) {
        require(router != address(0), "Invalid router");
        return IVaultRouter(router).buy{value: value}(token, amountOutMin, tipRate, deadline);
    }

    function routerSell(
        address router,
        address token,
        uint256 amountIn,
        uint256 amountOutMin,
        uint256 tipRate,
        uint256 deadline
    ) external onlyOrderBook returns (uint256 amountOut) {
        require(router != address(0), "Invalid router");
        IERC20(token).forceApprove(router, amountIn);
        amountOut = IVaultRouter(router).sell(token, amountIn, amountOutMin, tipRate, deadline);
        IERC20(token).forceApprove(router, 0);
    }

    receive() external payable {}
}
