// SPDX-License-Identifier: MIT
pragma solidity ^0.8.22;

import "@openzeppelin/contracts/token/ERC20/ERC20.sol";
import "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";

interface IMintableToken {
    function mint(address to, uint256 amount) external;
}

contract MockERC20 is ERC20 {
    uint8 private immutable tokenDecimals;

    constructor(string memory name_, string memory symbol_, uint8 decimals_)
        ERC20(name_, symbol_)
    {
        tokenDecimals = decimals_;
    }

    function decimals() public view override returns (uint8) {
        return tokenDecimals;
    }

    function mint(address to, uint256 amount) external {
        _mint(to, amount);
    }
}

contract MockRestrictedToken is MockERC20 {
    bool public transfersEnabled;

    constructor(string memory name_, string memory symbol_, uint8 decimals_)
        MockERC20(name_, symbol_, decimals_)
    {}

    function setTransfersEnabled(bool enabled) external {
        transfersEnabled = enabled;
    }

    function _update(address from, address to, uint256 value) internal override {
        if (from != address(0) && to != address(0) && !transfersEnabled) {
            revert("Transfers disabled");
        }
        super._update(from, to, value);
    }
}

contract MockDecimals18 {
    function decimals() external pure returns (uint8) {
        return 18;
    }
}

contract MockPair {
    address public token0;
    address public token1;

    uint112 private reserve0;
    uint112 private reserve1;

    function setTokens(address token0_, address token1_) external {
        token0 = token0_;
        token1 = token1_;
    }

    function setReserves(uint112 reserve0_, uint112 reserve1_) external {
        reserve0 = reserve0_;
        reserve1 = reserve1_;
    }

    function getReserves() external view returns (uint112, uint112, uint32) {
        return (reserve0, reserve1, 0);
    }
}

contract MockFactory {
    mapping(bytes32 => address) private pairs;

    function setPair(address tokenA, address tokenB, address pair) external {
        pairs[_key(tokenA, tokenB)] = pair;
        pairs[_key(tokenB, tokenA)] = pair;
    }

    function getPair(address tokenA, address tokenB) external view returns (address) {
        return pairs[_key(tokenA, tokenB)];
    }

    function _key(address tokenA, address tokenB) private pure returns (bytes32) {
        return keccak256(abi.encodePacked(tokenA, tokenB));
    }
}

contract MockFreedomRouter {
    using SafeERC20 for IERC20;

    uint256 public constant MAX_TIP_BPS = 500;
    uint256 public constant BPS_BASE = 10000;

    mapping(address => uint256) public buyRate;
    mapping(address => uint256) public fixedSellOut;
    mapping(address => uint8) public routeSource;

    struct RouterTokenInfo {
        string symbol;
        uint8 decimals;
        uint256 totalSupply;
        uint256 userBalance;
        uint8 routeSource;
    }

    function setBuyRate(address token, uint256 rate) external {
        buyRate[token] = rate;
    }

    function setFixedSellOut(address token, uint256 amountOut) external {
        fixedSellOut[token] = amountOut;
    }

    function setRouteSource(address token, uint8 route) external {
        routeSource[token] = route;
    }

    function fund() external payable {}

    function getTokenInfo(address token, address user) external view returns (RouterTokenInfo memory info) {
        info.decimals = 18;
        info.totalSupply = IERC20(token).totalSupply();
        info.userBalance = user == address(0) ? 0 : IERC20(token).balanceOf(user);
        info.routeSource = routeSource[token];
    }

    function buy(address token, uint256 amountOutMin, uint256 tipRate, uint256 deadline)
        external
        payable
        returns (uint256 amountOut)
    {
        require(block.timestamp <= deadline, "Expired");

        uint256 rate = tipRate <= MAX_TIP_BPS ? tipRate : MAX_TIP_BPS;
        uint256 tip = (msg.value * rate) / BPS_BASE;
        uint256 netValue = msg.value - tip;

        amountOut = (netValue * buyRate[token]) / 1e18;
        IMintableToken(token).mint(msg.sender, amountOut);
        require(amountOut >= amountOutMin, "Slippage");
    }

    function sell(address token, uint256 amountIn, uint256 amountOutMin, uint256 tipRate, uint256 deadline)
        external
        returns (uint256 amountOut)
    {
        require(block.timestamp <= deadline, "Expired");

        IERC20(token).safeTransferFrom(msg.sender, address(this), amountIn);

        uint256 grossOut = fixedSellOut[token];
        uint256 rate = tipRate <= MAX_TIP_BPS ? tipRate : MAX_TIP_BPS;
        uint256 tip = (grossOut * rate) / BPS_BASE;
        amountOut = grossOut - tip;

        require(amountOut >= amountOutMin, "Slippage");

        (bool ok,) = payable(msg.sender).call{value: amountOut}("");
        require(ok, "BNB transfer failed");
    }

    receive() external payable {}
}
