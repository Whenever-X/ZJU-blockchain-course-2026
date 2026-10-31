// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import "@openzeppelin/contracts/utils/Strings.sol";
import "./LiquidityPositionNFT.sol";

contract MiniDEX is ReentrancyGuard {
    using SafeERC20 for IERC20;
    using Strings for uint256;

    uint256 public constant FEE_BPS = 30;
    uint256 public constant BPS = 10_000;

    struct Pool {
        address tokenA;
        address tokenB;
        uint256 reserveA;
        uint256 reserveB;
        uint256 totalLiquidity;
        uint256 createdTimestamp;
    }

    struct Position {
        uint256 poolId;
        uint256 liquidity;
        uint256 depositedA;
        uint256 depositedB;
        uint256 createdTimestamp;
    }

    LiquidityPositionNFT public immutable positionNFT;
    uint256 public poolCount;
    mapping(uint256 => Pool) public pools;
    mapping(bytes32 => uint256) public poolByPair;
    mapping(bytes32 => uint256[]) private _poolsByPair;
    mapping(uint256 => Position) public positions;
    mapping(uint256 => uint256[]) private _poolPositionIds;

    event PoolCreated(uint256 indexed poolId, address indexed tokenA, address indexed tokenB);
    event LiquidityAdded(uint256 indexed poolId, uint256 indexed positionId, address indexed provider, uint256 amountA, uint256 amountB, uint256 liquidity);
    event LiquidityRemoved(uint256 indexed poolId, uint256 indexed positionId, address indexed provider, uint256 amountA, uint256 amountB);
    event Swapped(uint256 indexed poolId, address indexed trader, address tokenIn, uint256 amountIn, uint256 amountOut, address recipient);

    constructor(address nft) {
        require(nft != address(0), "zero nft");
        positionNFT = LiquidityPositionNFT(nft);
    }

    function createPool(address token0, address token1) external returns (uint256 poolId) {
        require(token0 != token1 && token0 != address(0) && token1 != address(0), "invalid pair");
        require(token0.code.length > 0 && token1.code.length > 0, "invalid token");
        (address tokenA, address tokenB) = token0 < token1 ? (token0, token1) : (token1, token0);
        bytes32 key = _pairKey(tokenA, tokenB);
        poolId = ++poolCount;
        pools[poolId] = Pool(tokenA, tokenB, 0, 0, 0, block.timestamp);
        // Keep the original lookup pointing at the first pool for compatibility.
        if (poolByPair[key] == 0) poolByPair[key] = poolId;
        _poolsByPair[key].push(poolId);
        emit PoolCreated(poolId, tokenA, tokenB);
    }

    function addLiquidity(uint256 poolId, uint256 amountA, uint256 amountB, address recipient)
        external
        nonReentrant
        returns (uint256 positionId, uint256 usedA, uint256 usedB, uint256 liquidity)
    {
        require(recipient != address(0), "zero recipient");
        Pool storage pool = pools[poolId];
        require(pool.tokenA != address(0), "pool missing");
        require(amountA > 0 && amountB > 0, "zero amounts");
        if (pool.totalLiquidity == 0) {
            usedA = amountA;
            usedB = amountB;
            liquidity = _sqrt(usedA * usedB);
        } else {
            uint256 liqA = amountA * pool.totalLiquidity / pool.reserveA;
            uint256 liqB = amountB * pool.totalLiquidity / pool.reserveB;
            liquidity = liqA < liqB ? liqA : liqB;
            require(liquidity > 0, "insufficient liquidity");
            usedA = liquidity * pool.reserveA / pool.totalLiquidity;
            usedB = liquidity * pool.reserveB / pool.totalLiquidity;
        }
        require(liquidity > 0, "insufficient liquidity");
        IERC20(pool.tokenA).safeTransferFrom(msg.sender, address(this), usedA);
        IERC20(pool.tokenB).safeTransferFrom(msg.sender, address(this), usedB);
        pool.reserveA += usedA;
        pool.reserveB += usedB;
        pool.totalLiquidity += liquidity;
        positionId = positionNFT.mint(recipient);
        positions[positionId] = Position(poolId, liquidity, usedA, usedB, block.timestamp);
        _poolPositionIds[poolId].push(positionId);
        positionNFT.setTokenURI(positionId, string(abi.encodePacked(
            "data:application/json,{\"name\":\"MiniDEX LP #", positionId.toString(),
            "\",\"poolId\":\"", poolId.toString(),
            "\",\"tokenA\":\"", Strings.toHexString(uint160(pool.tokenA), 20),
            "\",\"tokenB\":\"", Strings.toHexString(uint160(pool.tokenB), 20),
            "\",\"depositedA\":\"", usedA.toString(),
            "\",\"depositedB\":\"", usedB.toString(),
            "\",\"createdTimestamp\":\"", block.timestamp.toString(), "\"}"
        )));
        emit LiquidityAdded(poolId, positionId, recipient, usedA, usedB, liquidity);
    }

    function removeLiquidity(uint256 positionId) external nonReentrant returns (uint256 amountA, uint256 amountB) {
        require(positionNFT.ownerOf(positionId) == msg.sender, "not position owner");
        Position memory position = positions[positionId];
        Pool storage pool = pools[position.poolId];
        amountA = pool.reserveA * position.liquidity / pool.totalLiquidity;
        amountB = pool.reserveB * position.liquidity / pool.totalLiquidity;
        delete positions[positionId];
        pool.reserveA -= amountA;
        pool.reserveB -= amountB;
        pool.totalLiquidity -= position.liquidity;
        positionNFT.burn(positionId);
        IERC20(pool.tokenA).safeTransfer(msg.sender, amountA);
        IERC20(pool.tokenB).safeTransfer(msg.sender, amountB);
        emit LiquidityRemoved(position.poolId, positionId, msg.sender, amountA, amountB);
    }

    function swap(uint256 poolId, address tokenIn, uint256 amountIn, uint256 minAmountOut, address recipient)
        external
        nonReentrant
        returns (uint256 amountOut)
    {
        require(recipient != address(0) && amountIn > 0, "invalid swap");
        Pool storage pool = pools[poolId];
        bool aToB = tokenIn == pool.tokenA;
        require(aToB || tokenIn == pool.tokenB, "token not in pool");
        (uint256 reserveIn, uint256 reserveOut) = aToB ? (pool.reserveA, pool.reserveB) : (pool.reserveB, pool.reserveA);
        amountOut = quoteAmountOut(amountIn, reserveIn, reserveOut);
        require(amountOut >= minAmountOut && amountOut < reserveOut, "slippage");
        IERC20(tokenIn).safeTransferFrom(msg.sender, address(this), amountIn);
        if (aToB) {
            pool.reserveA += amountIn;
            pool.reserveB -= amountOut;
            IERC20(pool.tokenB).safeTransfer(recipient, amountOut);
        } else {
            pool.reserveB += amountIn;
            pool.reserveA -= amountOut;
            IERC20(pool.tokenA).safeTransfer(recipient, amountOut);
        }
        emit Swapped(poolId, msg.sender, tokenIn, amountIn, amountOut, recipient);
    }

    function quoteAmountOut(uint256 amountIn, uint256 reserveIn, uint256 reserveOut) public pure returns (uint256) {
        require(amountIn > 0 && reserveIn > 0 && reserveOut > 0, "empty pool");
        uint256 amountInWithFee = amountIn * (BPS - FEE_BPS);
        return amountInWithFee * reserveOut / (reserveIn * BPS + amountInWithFee);
    }

    function getPool(uint256 poolId) external view returns (Pool memory) {
        return pools[poolId];
    }

    function getPoolsByPair(address token0, address token1) external view returns (uint256[] memory) {
        (address tokenA, address tokenB) = token0 < token1 ? (token0, token1) : (token1, token0);
        return _poolsByPair[_pairKey(tokenA, tokenB)];
    }

    function getPoolPositionIds(uint256 poolId) external view returns (uint256[] memory) {
        return _poolPositionIds[poolId];
    }

    function getPosition(uint256 positionId) external view returns (Position memory) {
        return positions[positionId];
    }

    function _pairKey(address tokenA, address tokenB) private pure returns (bytes32) {
        return keccak256(abi.encodePacked(tokenA, tokenB));
    }

    function _sqrt(uint256 value) private pure returns (uint256 result) {
        if (value == 0) return 0;
        uint256 x = value;
        result = 1;
        if (x >= 2**128) { x >>= 128; result <<= 64; }
        if (x >= 2**64) { x >>= 64; result <<= 32; }
        if (x >= 2**32) { x >>= 32; result <<= 16; }
        if (x >= 2**16) { x >>= 16; result <<= 8; }
        if (x >= 2**8) { x >>= 8; result <<= 4; }
        if (x >= 2**4) { x >>= 4; result <<= 2; }
        if (x >= 2**2) { result <<= 1; }
        for (uint256 i = 0; i < 7; i++) result = (result + value / result) >> 1;
        uint256 rounded = value / result;
        return result < rounded ? result : rounded;
    }
}
