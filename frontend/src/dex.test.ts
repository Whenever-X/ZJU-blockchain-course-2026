import { describe, expect, it } from 'vitest';
import { Interface, parseEther } from 'ethers';
import { buildArbitrageRoutes, friendlyError, quotePool, quoteRaw } from './dex';
import type { PoolView } from './dex';

const a = '0x0000000000000000000000000000000000000001';
const b = '0x0000000000000000000000000000000000000002';
const c = '0x0000000000000000000000000000000000000003';
function pool(dexKey: string, poolId: number, reserveA = '1000', reserveB = '1000'): PoolView {
  return { dexKey, poolId, dexLabel: dexKey, dexAddress: dexKey, nftAddress: '', tokenA: a, tokenB: b, reserveA: parseEther(reserveA), reserveB: parseEther(reserveB), totalLiquidity: 1n, createdTimestamp: 0n, positions: [] };
}

describe('arbitrage routing', () => {
  it('includes all cross-DEX and same-DEX routes, including newly created pools', () => {
    const pools = [pool('dex1', 1), pool('dex1', 2, '1000', '2000'), pool('dex2', 1), pool('dex2', 7, '2000', '1000')];
    const routes = buildArbitrageRoutes(pools, a, parseEther('10'));
    expect(routes).toHaveLength(12);
    expect(routes[0].first.poolId).toBe(2);
    expect(routes[0].second.poolId).toBe(7);
    expect(routes[0].profit).toBeGreaterThan(0n);
    expect(routes.some(route => route.first.dexKey === route.second.dexKey)).toBe(true);
  });

  it('uses token addresses rather than reserve order, and supports B as principal', () => {
    const first = pool('dex1', 1, '1000', '2000');
    const second = pool('dex2', 1, '2000', '1000');
    const reversed = { ...second, tokenA: b, tokenB: a, reserveA: second.reserveB, reserveB: second.reserveA };
    const normal = buildArbitrageRoutes([first, second], b, parseEther('10'));
    const actual = buildArbitrageRoutes([first, reversed], b, parseEther('10'));
    expect(actual.map(route => route.profit)).toEqual(normal.map(route => route.profit));
    expect(actual[0].first.dexKey).toBe('dex2');
  });

  it('excludes empty and mismatched pools and retains losing quotes for comparison', () => {
    const routes = buildArbitrageRoutes([pool('dex1', 1), pool('dex2', 1), pool('dex1', 2, '0'), { ...pool('dex2', 2), tokenB: c }], a, parseEther('10'));
    expect(routes).toHaveLength(2);
    expect(routes.every(route => route.profit < 0n)).toBe(true);
    expect(buildArbitrageRoutes([pool('dex1', 1)], a, 0n)).toEqual([]);
    expect(quotePool(pool('dex1', 1), c, 1n)).toBe(0n);
  });

  it('accounts for price impact so an excessive principal can erase the apparent spread', () => {
    const pools = [pool('dex1', 1), pool('dex2', 1, '2000', '1000')];
    expect(buildArbitrageRoutes(pools, a, parseEther('10'))[0].profit).toBeGreaterThan(0n);
    expect(buildArbitrageRoutes(pools, a, parseEther('5000'))[0].profit).toBeLessThan(0n);
    expect(quoteRaw(1000n, 1000n, 1000n)).toBe(499n);
  });
});

describe('wallet error messages', () => {
  it('decodes nested ERC20 custom errors into Chinese without leaking the raw payload', () => {
    const iface = new Interface(['error ERC20InsufficientBalance(address,uint256,uint256)']);
    const data = iface.encodeErrorResult('ERC20InsufficientBalance', [a, 1n, 100n]);
    const message = friendlyError({ code: 'CALL_EXCEPTION', info: { error: { data } } });
    expect(message).toContain('代币余额不足');
    expect(message).not.toContain('0x');
  });
  it('distinguishes cancellation, allowance, gas and profitability failures', () => {
    expect(friendlyError({ code: 4001 })).toContain('取消');
    expect(friendlyError(new Error('transfer amount exceeds allowance'))).toContain('授权额度不足');
    expect(friendlyError({ code: 'INSUFFICIENT_FUNDS' })).toContain('ETH');
    expect(friendlyError(new Error('execution reverted: slippage'))).toContain('整体回滚');
    expect(friendlyError(new Error('unknown raw provider dump'))).not.toContain('raw');
  });
});
