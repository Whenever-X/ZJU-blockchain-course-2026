// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import "./MiniDEX.sol";

contract Arbitrageur is ReentrancyGuard {
    using SafeERC20 for IERC20;

    event ArbitrageExecuted(address indexed trader, address indexed token, uint256 input, uint256 output, uint256 profit);

    function execute(
        address lowDex,
        uint256 lowPoolId,
        address highDex,
        uint256 highPoolId,
        address tokenIn,
        uint256 amountIn,
        uint256 minIntermediate,
        uint256 minProfit,
        address recipient
    ) external nonReentrant returns (uint256 profit) {
        require(recipient != address(0) && amountIn > 0, "invalid arbitrage");
        require(lowDex != highDex || lowPoolId != highPoolId, "same pool");
        uint256 beforeBalance = IERC20(tokenIn).balanceOf(address(this));
        {
            address intermediate = _otherToken(lowDex, lowPoolId, tokenIn);
            require(_otherToken(highDex, highPoolId, intermediate) == tokenIn, "pair mismatch");
            uint256 intermediateBefore = IERC20(intermediate).balanceOf(address(this));
            IERC20(tokenIn).safeTransferFrom(msg.sender, address(this), amountIn);
            IERC20(tokenIn).forceApprove(lowDex, amountIn);
            MiniDEX(lowDex).swap(lowPoolId, tokenIn, amountIn, minIntermediate, address(this));

            // Only spend the output of this trade; never consume pre-existing dust.
            uint256 intermediateBalance = IERC20(intermediate).balanceOf(address(this)) - intermediateBefore;
            IERC20(intermediate).forceApprove(highDex, intermediateBalance);
            MiniDEX(highDex).swap(highPoolId, intermediate, intermediateBalance, amountIn + minProfit, address(this));
        }
        uint256 output = IERC20(tokenIn).balanceOf(address(this)) - beforeBalance;
        require(output >= amountIn + minProfit, "unprofitable");
        profit = output - amountIn;
        IERC20(tokenIn).safeTransfer(recipient, output);
        emit ArbitrageExecuted(msg.sender, tokenIn, amountIn, output, profit);
    }

    function _otherToken(address dex, uint256 poolId, address tokenIn) private view returns (address) {
        MiniDEX.Pool memory pool = MiniDEX(dex).getPool(poolId);
        if (pool.tokenA == tokenIn) return pool.tokenB;
        require(pool.tokenB == tokenIn, "token not in pool");
        return pool.tokenA;
    }
}
