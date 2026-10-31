import { Interface } from 'ethers';

export type PositionView = { id: bigint; poolId: bigint; liquidity: bigint; depositedA: bigint; depositedB: bigint; createdTimestamp: bigint; owner: string; metadataUri: string };
export type PoolView = { dexKey: string; dexLabel: string; dexAddress: string; nftAddress: string; poolId: number; tokenA: string; tokenB: string; reserveA: bigint; reserveB: bigint; totalLiquidity: bigint; createdTimestamp: bigint; positions: PositionView[] };
export type ArbitrageRoute = { id: string; first: PoolView; second: PoolView; tokenIn: string; intermediateToken: string; amount: bigint; intermediate: bigint; output: bigint; profit: bigint };

export const sameAddress = (a: string, b: string) => a.toLowerCase() === b.toLowerCase();
export const poolKey = (pool: PoolView) => `${pool.dexKey}-${pool.poolId}`;
export const poolLabel = (pool: PoolView) => `${pool.dexLabel} / 池 #${pool.poolId}`;
export function quoteRaw(amount: bigint, reserveIn: bigint, reserveOut: bigint) {
  return amount > 0n && reserveIn > 0n && reserveOut > 0n
    ? amount * 9970n * reserveOut / (reserveIn * 10000n + amount * 9970n) : 0n;
}
export function quotePool(pool: PoolView, tokenIn: string, amount: bigint) {
  if (sameAddress(tokenIn, pool.tokenA)) return quoteRaw(amount, pool.reserveA, pool.reserveB);
  if (sameAddress(tokenIn, pool.tokenB)) return quoteRaw(amount, pool.reserveB, pool.reserveA);
  return 0n;
}

// Evaluate actual two-swap outputs, including fees and price impact, for every route.
export function buildArbitrageRoutes(pools: PoolView[], tokenIn: string, amount: bigint): ArbitrageRoute[] {
  if (amount <= 0n) return [];
  const active = pools.filter(pool => pool.reserveA > 0n && pool.reserveB > 0n &&
    (sameAddress(pool.tokenA, tokenIn) || sameAddress(pool.tokenB, tokenIn)));
  return active.flatMap(first => {
    const intermediateToken = sameAddress(first.tokenA, tokenIn) ? first.tokenB : first.tokenA;
    return active.filter(second => poolKey(first) !== poolKey(second) &&
      (sameAddress(second.tokenA, intermediateToken) || sameAddress(second.tokenB, intermediateToken)))
      .map(second => {
        const intermediate = quotePool(first, tokenIn, amount);
        const output = quotePool(second, intermediateToken, intermediate);
        return { id: `${poolKey(first)}>${poolKey(second)}`, first, second, tokenIn, intermediateToken, amount, intermediate, output, profit: output - amount };
      });
  }).sort((a, b) => a.profit > b.profit ? -1 : a.profit < b.profit ? 1 : a.id.localeCompare(b.id));
}

const errors = new Interface([
  'error ERC20InsufficientBalance(address sender,uint256 balance,uint256 needed)',
  'error ERC20InsufficientAllowance(address spender,uint256 allowance,uint256 needed)',
  'error ERC721NonexistentToken(uint256 tokenId)',
]);

export function friendlyError(error: unknown): string {
  const messages: string[] = [];
  const visited = new Set<unknown>();
  const visit = (value: unknown, depth = 0) => {
    if (depth > 5 || value == null || visited.has(value)) return;
    if (typeof value === 'string' || typeof value === 'number') {
      messages.push(String(value));
      if (typeof value === 'string' && /^0x[0-9a-f]+$/i.test(value)) {
        try { const decoded = errors.parseError(value); if (decoded) messages.push(decoded.name); } catch { /* not revert data */ }
      }
    } else if (typeof value === 'object') {
      visited.add(value);
      for (const key of ['code', 'message', 'shortMessage', 'reason', 'data', 'error', 'info', 'cause', 'revert', 'name']) {
        visit((value as Record<string, unknown>)[key], depth + 1);
      }
    }
  };
  visit(error);
  const text = messages.join(' ').toLowerCase();
  if (/4001|action_rejected|user rejected|user denied/.test(text)) return '你已取消钱包操作，可以调整后重试。';
  if (/insufficient_funds|insufficient funds|gas required exceeds|funds for gas/.test(text)) return '测试 ETH 不足以支付网络费，请导入有 ETH 的本地测试账户，或先补充测试 ETH。';
  if (/erc20insufficientbalance|exceeds balance|exceeds the balance|balance too low|代币余额不足/.test(text)) return '代币余额不足，请减少数量或先领取测试代币。';
  if (/erc20insufficientallowance|exceeds allowance|insufficient allowance|尚未授权/.test(text)) return '代币授权额度不足，请先完成授权，再重试本次操作。';
  if (/unprofitable|slippage|利润不足/.test(text)) return '当前价格下无法满足最低利润或滑点要求。请刷新报价、减少本金或调整最低利润；套利交易中的兑换会整体回滚。';
  if (/not position owner/.test(text)) return '这个流动性 NFT 不属于当前钱包，请切换账户或选择自己的 NFT。';
  if (/erc721nonexistenttoken|invalid token id/.test(text)) return '这个 NFT 不存在或已被销毁，请检查交易所和 NFT 编号。';
  if (/invalid pair|相同代币/.test(text)) return '请选择两种不同的代币来创建交易池。';
  if (/empty pool|insufficient liquidity|zero amounts|流动性不足/.test(text)) return '池子流动性不足或输入数量太小，请先添加流动性，或调整数量。';
  if (/invalid_argument|numeric_fault|underflow|overflow|invalid swap|数量无效/.test(text)) return '请输入有效的正数，代币数量最多支持 18 位小数。';
  if (/bad_data|could not decode|尚未部署/.test(text)) return '当前网络上的合约与页面配置不匹配，请确认本地节点正在运行，并重新部署合约后刷新页面。';
  if (/network_error|failed to fetch|econnrefused|could not coalesce|disconnected/.test(text)) return '无法连接本地链或钱包，请检查节点和 MetaMask 网络后重试。';
  if (/wallet required|未检测到 metamask/.test(text)) return '请先安装 MetaMask，并连接本地测试网络中的账户。';
  if (/network mismatch/.test(text)) return '钱包网络不匹配，请将 MetaMask 切换到部署合约所使用的本地网络，再重新连接。';
  if (/exceed/.test(text)) return '本次操作超过了可用余额、授权额度或池子限额，请检查数量与授权后重试。';
  return '操作未能完成，请检查余额、授权和池子状态后重试。若交易已在链上失败，交易中的资产变更会回滚，已支付的网络费仍会消耗。';
}
