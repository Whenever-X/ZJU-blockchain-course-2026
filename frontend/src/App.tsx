import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { BrowserProvider, Contract, ethers, JsonRpcSigner } from 'ethers';
import type { ContractTransactionReceipt } from 'ethers';
import './App.css';
import Icon from './Icon';
import deployments from './deployments.local.json';
import { buildArbitrageRoutes, friendlyError, poolKey, poolLabel, quotePool, sameAddress } from './dex';
import type { ArbitrageRoute, PoolView, PositionView } from './dex';

declare global { interface Window { ethereum?: Eip1193Provider } }
interface Eip1193Provider {
  request: (args: { method: string; params?: unknown[] }) => Promise<unknown>;
  on?: (event: string, listener: () => void) => void;
  removeListener?: (event: string, listener: () => void) => void;
}

const erc20Abi = ['function balanceOf(address) view returns (uint256)', 'function allowance(address,address) view returns (uint256)', 'function approve(address,uint256) returns (bool)', 'function faucet(address,uint256)'];
const dexAbi = [
  'function poolCount() view returns (uint256)',
  'function getPool(uint256) view returns (address tokenA,address tokenB,uint256 reserveA,uint256 reserveB,uint256 totalLiquidity,uint256 createdTimestamp)',
  'function getPoolPositionIds(uint256) view returns (uint256[])',
  'function getPosition(uint256) view returns (uint256 poolId,uint256 liquidity,uint256 depositedA,uint256 depositedB,uint256 createdTimestamp)',
  'function createPool(address,address) returns (uint256)',
  'function swap(uint256,address,uint256,uint256,address) returns (uint256)',
  'function addLiquidity(uint256,uint256,uint256,address) returns (uint256,uint256,uint256,uint256)',
  'function removeLiquidity(uint256) returns (uint256,uint256)',
  'event PoolCreated(uint256 indexed poolId,address indexed tokenA,address indexed tokenB)',
  'event Swapped(uint256 indexed poolId,address indexed trader,address tokenIn,uint256 amountIn,uint256 amountOut,address recipient)',
];
const nftAbi = ['function ownerOf(uint256) view returns (address)', 'function tokenURI(uint256) view returns (string)'];
const arbitrageAbi = [
  'function execute(address,uint256,address,uint256,address,uint256,uint256,uint256,address) returns (uint256)',
  'event ArbitrageExecuted(address indexed trader,address indexed token,uint256 input,uint256 output,uint256 profit)',
];
const config = { ...deployments };
const dexConfigs = [
  { key: 'dex1', label: 'DEX 1', address: config.dex1, nft: config.nft1 },
  { key: 'dex2', label: 'DEX 2', address: config.dex2, nft: config.nft2 },
] as const;
const tokens = [{ address: config.tokenA, label: 'Token A' }, { address: config.tokenB, label: 'Token B' }];
const navigation = [
  { id: 'overview', label: '资产概览', icon: 'overview' },
  { id: 'pools', label: '交易池', icon: 'pools' },
  { id: 'trade', label: '兑换与流动性', icon: 'swap' },
  { id: 'positions', label: 'NFT 仓位', icon: 'nft' },
  { id: 'arbitrage', label: '原子套利', icon: 'bolt' },
] as const;
function TokenIcon({ address }: { address: string }) {
  const isA = sameAddress(address, config.tokenA);
  return <span className={`token-icon ${isA ? 'coin-a' : 'coin-b'}`} aria-hidden="true">{isA ? 'A' : 'B'}</span>;
}
const tokenName = (address: string) => tokens.find(token => sameAddress(token.address, address))?.label ?? short(address);
function format(value: bigint | undefined, digits = 4) { return value === undefined ? '-' : Number(ethers.formatEther(value)).toLocaleString(undefined, { maximumFractionDigits: digits }); }
function ratio(a: bigint, b: bigint) { return b === 0n ? '-' : format(a * 10n ** 18n / b, 6); }
function short(value: string) { return `${value.slice(0, 6)}...${value.slice(-4)}`; }
function date(value: bigint) { return new Date(Number(value) * 1000).toLocaleString(); }
function amount(value: string, allowZero = false) {
  const parsed = ethers.parseEther(value);
  if (parsed < 0n || (!allowZero && parsed === 0n)) throw new Error('数量无效');
  return parsed;
}
function maybeAmount(value: string, allowZero = false) { try { return amount(value, allowZero); } catch { return undefined; } }
async function latestBlock(provider: BrowserProvider) { return Number(BigInt(await provider.send('eth_blockNumber', []))); }
function price(pool: PoolView) {
  const aFirst = sameAddress(pool.tokenA, config.tokenA);
  return ratio(aFirst ? pool.reserveB : pool.reserveA, aFirst ? pool.reserveA : pool.reserveB);
}
function findEvent(receipt: ContractTransactionReceipt, address: string, abi: string[], name: string) {
  const iface = new ethers.Interface(abi);
  for (const log of receipt.logs) {
    if (!sameAddress(log.address, address)) continue;
    try { const event = iface.parseLog(log); if (event?.name === name) return event; } catch { /* another event */ }
  }
}

async function readPools(provider: BrowserProvider, blockTag: number): Promise<PoolView[]> {
  const groups = await Promise.all(dexConfigs.map(async dexConfig => {
    const dex = new Contract(dexConfig.address, dexAbi, provider);
    const nft = new Contract(dexConfig.nft, nftAbi, provider);
    const count = Number(await dex.poolCount({ blockTag }));
    return Promise.all(Array.from({ length: count }, async (_, index) => {
      const poolId = index + 1;
      const pool = await dex.getPool(poolId, { blockTag });
      const ids: bigint[] = await dex.getPoolPositionIds(poolId, { blockTag });
      const positions = (await Promise.all(ids.map(async id => {
        const position = await dex.getPosition(id, { blockTag });
        if (position.liquidity === 0n) return undefined;
        const [owner, metadataUri] = await Promise.all([nft.ownerOf(id, { blockTag }), nft.tokenURI(id, { blockTag })]);
        return { id, poolId: position.poolId, liquidity: position.liquidity, depositedA: position.depositedA, depositedB: position.depositedB, createdTimestamp: position.createdTimestamp, owner, metadataUri } as PositionView;
      }))).filter((position): position is PositionView => position !== undefined);
      return { dexKey: dexConfig.key, dexLabel: dexConfig.label, dexAddress: dexConfig.address, nftAddress: dexConfig.nft, poolId, tokenA: pool.tokenA, tokenB: pool.tokenB, reserveA: pool.reserveA, reserveB: pool.reserveB, totalLiquidity: pool.totalLiquidity, createdTimestamp: pool.createdTimestamp, positions };
    }));
  }));
  return groups.flat();
}

async function poolSnapshot(provider: BrowserProvider, pool: PoolView, blockTag: number): Promise<PoolView> {
  const current = await new Contract(pool.dexAddress, dexAbi, provider).getPool(pool.poolId, { blockTag });
  return { ...pool, reserveA: current.reserveA, reserveB: current.reserveB, totalLiquidity: current.totalLiquidity };
}

type ArbReport = {
  route: ArbitrageRoute; hash: string; block: number; gasFee: bigint; intermediate: bigint; output: bigint; profit: bigint;
  beforeInput: bigint; afterInput: bigint; beforeOther: bigint; afterOther: bigint; beforePools: PoolView[]; afterPools: PoolView[];
};

function App() {
  const [provider, setProvider] = useState<BrowserProvider>();
  const [signer, setSigner] = useState<JsonRpcSigner>();
  const [account, setAccount] = useState('');
  const [status, setStatus] = useState('请启动本地节点、部署合约，再连接 MetaMask。');
  const [busy, setBusy] = useState('');
  const busyRef = useRef(false);
  const [alert, setAlert] = useState<{ title: string; message: string; kind?: 'error' | 'success' | 'info'; details?: string }>();
  const [activeSection, setActiveSection] = useState('overview');
  const [poolFilter, setPoolFilter] = useState('all');
  const [positionFilter, setPositionFilter] = useState('all');
  const closeButton = useRef<HTMLButtonElement>(null);
  const dialogRef = useRef<HTMLElement>(null);
  const [balances, setBalances] = useState({ eth: '-', a: '-', b: '-' });
  const [pools, setPools] = useState<PoolView[]>([]);
  const [selectedKey, setSelectedKey] = useState('dex1-1');
  const [amountIn, setAmountIn] = useState('1');
  const [swapToken, setSwapToken] = useState(config.tokenA);
  const [liquidityA, setLiquidityA] = useState('10');
  const [liquidityB, setLiquidityB] = useState('10');
  const [positionId, setPositionId] = useState('1');
  const [positionDex, setPositionDex] = useState('dex1');
  const [createDex, setCreateDex] = useState('dex1');
  const [poolToken0, setPoolToken0] = useState(config.tokenA);
  const [poolToken1, setPoolToken1] = useState(config.tokenB);
  const [arbToken, setArbToken] = useState(config.tokenA);
  const [arbAmount, setArbAmount] = useState('10');
  const [minProfit, setMinProfit] = useState('0.01');
  const [routeId, setRouteId] = useState('best');
  const [arbAllowance, setArbAllowance] = useState(0n);
  const [autoRefresh, setAutoRefresh] = useState(true);
  const [updated, setUpdated] = useState<{ time: string; block: number }>();
  const [readFailed, setReadFailed] = useState(false);
  const [pendingHash, setPendingHash] = useState('');
  const [arbReport, setArbReport] = useState<ArbReport>();
  const requestId = useRef(0);

  const showError = useCallback((error: unknown, title = '操作未完成') => setAlert({ title, message: friendlyError(error), kind: 'error' }), []);
  const selectedPool = pools.find(pool => poolKey(pool) === selectedKey);
  const arbInput = maybeAmount(arbAmount);
  const profitFloor = maybeAmount(minProfit, true);
  const routes = useMemo(() => buildArbitrageRoutes(pools, arbToken, arbInput ?? 0n), [pools, arbToken, arbInput]);
  const plan = routeId === 'best' ? routes[0] : routes.find(route => route.id === routeId);
  const opportunity = plan && profitFloor !== undefined && plan.profit > 0n && plan.profit >= profitFloor;
  const approved = arbInput !== undefined && arbAllowance >= arbInput;
  const quote = selectedPool ? quotePool(selectedPool, swapToken, maybeAmount(amountIn) ?? 0n) : 0n;

  const refresh = useCallback(async (notify = false) => {
    if (!provider || !account) return;
    const id = ++requestId.current;
    try {
      const block = await latestBlock(provider);
      const [eth, a, b, allowance, nextPools] = await Promise.all([
        provider.getBalance(account, block),
        new Contract(config.tokenA, erc20Abi, provider).balanceOf(account, { blockTag: block }),
        new Contract(config.tokenB, erc20Abi, provider).balanceOf(account, { blockTag: block }),
        new Contract(arbToken, erc20Abi, provider).allowance(account, config.arbitrageur, { blockTag: block }),
        readPools(provider, block),
      ]);
      if (id !== requestId.current) return;
      setBalances({ eth: format(eth), a: format(a), b: format(b) });
      setPools(nextPools); setArbAllowance(allowance); setReadFailed(false);
      setUpdated({ time: new Date().toLocaleTimeString(), block });
    } catch (error) {
      if (id !== requestId.current) return;
      setReadFailed(true);
      if (notify) showError(error, '无法读取链上状态');
    }
  }, [account, arbToken, provider, showError]);

  useEffect(() => { void refresh(true); return () => { requestId.current++; }; }, [refresh]);
  useEffect(() => {
    if (typeof IntersectionObserver === 'undefined') return;
    const observer = new IntersectionObserver(() => {
      const visible = navigation.map(item => document.getElementById(item.id)).filter((section): section is HTMLElement => {
        if (!section) return false;
        const rect = section.getBoundingClientRect();
        return rect.top <= window.innerHeight * .4 && rect.bottom > 0;
      }).at(-1);
      if (visible) setActiveSection(visible.id);
    }, { rootMargin: '-15% 0px -65% 0px', threshold: 0 });
    navigation.forEach(item => { const section = document.getElementById(item.id); if (section) observer.observe(section); });
    return () => observer.disconnect();
  }, []);
  useEffect(() => {
    if (!autoRefresh || !provider) return;
    const timer = window.setInterval(() => { if (!busyRef.current) void refresh(); }, 5000);
    return () => window.clearInterval(timer);
  }, [autoRefresh, provider, refresh]);
  useEffect(() => {
    if (!alert) return;
    const previous = document.activeElement as HTMLElement | null;
    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    closeButton.current?.focus();
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') setAlert(undefined);
      if (event.key === 'Tab') {
        const controls = dialogRef.current?.querySelectorAll<HTMLElement>('button:not(:disabled),summary,a[href],[tabindex="0"]');
        const first = controls?.[0]; const last = controls?.[controls.length - 1];
        if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last?.focus(); }
        else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first?.focus(); }
      }
    };
    window.addEventListener('keydown', onKey);
    return () => { window.removeEventListener('keydown', onKey); document.body.style.overflow = previousOverflow; previous?.focus(); };
  }, [alert]);
  useEffect(() => {
    const wallet = window.ethereum;
    const reset = () => {
      requestId.current++; setProvider(undefined); setSigner(undefined); setAccount(''); setPools([]);
      setArbAllowance(0n); setArbReport(undefined); setUpdated(undefined); setReadFailed(false);
      setBalances({ eth: '-', a: '-', b: '-' }); setStatus('钱包账户或网络已变更，请重新连接。');
    };
    wallet?.on?.('accountsChanged', reset); wallet?.on?.('chainChanged', reset);
    return () => { wallet?.removeListener?.('accountsChanged', reset); wallet?.removeListener?.('chainChanged', reset); };
  }, []);
  useEffect(() => {
    if (selectedPool && !sameAddress(swapToken, selectedPool.tokenA) && !sameAddress(swapToken, selectedPool.tokenB)) setSwapToken(selectedPool.tokenA);
  }, [selectedPool, swapToken]);

  const run = async <T,>(message: string, action: () => Promise<T>): Promise<T | undefined> => {
    if (busyRef.current) return;
    busyRef.current = true; setBusy(message); setStatus(`${message}：请在钱包中确认。`);
    try {
      const result = await action();
      setStatus(`${message}完成。`); await refresh(); return result;
    } catch (error) { setStatus('操作未完成，请查看提示。'); showError(error); }
    finally { busyRef.current = false; setBusy(''); setPendingHash(''); }
  };
  const connect = () => run('连接钱包', async () => {
    if (!window.ethereum) throw new Error('未检测到 MetaMask');
    const nextProvider = new BrowserProvider(window.ethereum);
    await nextProvider.send('eth_requestAccounts', []);
    const network = await nextProvider.getNetwork();
    if (network.chainId !== BigInt(config.chainId)) throw new Error('network mismatch');
    const addresses = [config.tokenA, config.tokenB, config.dex1, config.dex2, config.nft1, config.nft2, config.arbitrageur];
    if ((await Promise.all(addresses.map(address => nextProvider.getCode(address)))).some(code => code === '0x')) throw new Error('尚未部署');
    const nextSigner = await nextProvider.getSigner();
    setProvider(nextProvider); setSigner(nextSigner); setAccount(await nextSigner.getAddress());
  });

  const dexContract = (address: string) => { if (!signer) throw new Error('wallet required'); return new Contract(address, dexAbi, signer); };
  const tokenContract = (address: string) => { if (!signer) throw new Error('wallet required'); return new Contract(address, erc20Abi, signer); };
  const approveIfNeeded = async (token: Contract, spender: string, value: bigint) => {
    if (await token.balanceOf(account) < value) throw new Error('代币余额不足');
    if (await token.allowance(account, spender) < value) await (await token.approve(spender, value)).wait();
  };
  const faucet = (address: string) => run(`领取 ${tokenName(address)}`, async () => (await tokenContract(address).faucet(account, ethers.parseEther('1000'))).wait());
  const swap = () => run('兑换', async () => {
    if (!selectedPool || !provider) throw new Error('流动性不足');
    const input = amount(amountIn);
    const current = await poolSnapshot(provider, selectedPool, await latestBlock(provider));
    const expected = quotePool(current, swapToken, input);
    if (expected === 0n) throw new Error('流动性不足');
    await approveIfNeeded(tokenContract(swapToken), selectedPool.dexAddress, input);
    return (await dexContract(selectedPool.dexAddress).swap(selectedPool.poolId, swapToken, input, expected * 995n / 1000n, account)).wait();
  });
  const addLiquidity = () => run('添加流动性并铸造 NFT', async () => {
    if (!selectedPool) throw new Error('流动性不足');
    const a = amount(liquidityA); const b = amount(liquidityB);
    await approveIfNeeded(tokenContract(selectedPool.tokenA), selectedPool.dexAddress, a);
    await approveIfNeeded(tokenContract(selectedPool.tokenB), selectedPool.dexAddress, b);
    return (await dexContract(selectedPool.dexAddress).addLiquidity(selectedPool.poolId, a, b, account)).wait();
  });
  const removePosition = (dexKey: string, id: string) => run('销毁 NFT 并取回资产', async () => {
    if (!/^\d+$/.test(id) || BigInt(id) === 0n) throw new Error('ERC721NonexistentToken');
    const dex = dexConfigs.find(item => item.key === dexKey)!;
    return (await dexContract(dex.address).removeLiquidity(BigInt(id))).wait();
  });
  const createPool = () => run('创建交易池', async () => {
    if (sameAddress(poolToken0, poolToken1)) throw new Error('相同代币');
    const dex = dexConfigs.find(item => item.key === createDex)!;
    const receipt = await (await dexContract(dex.address).createPool(poolToken0, poolToken1)).wait() as ContractTransactionReceipt;
    const event = findEvent(receipt, dex.address, dexAbi, 'PoolCreated');
    if (event) { setSelectedKey(`${dex.key}-${event.args.poolId}`); setSwapToken(poolToken0); }
    setPoolFilter('all');
    setAlert({ title: '交易池已创建', message: `${dex.label} 的新池已创建并选中。请在“添加流动性”中存入两种代币；首次存入的比例决定初始价格。`, kind: 'success' });
    return receipt;
  });
  const approveArbitrage = () => run('准备套利授权', async () => {
    if (!arbInput) throw new Error('数量无效');
    return (await tokenContract(arbToken).approve(config.arbitrageur, arbInput)).wait();
  });
  const arbitrage = () => run('原子套利', async () => {
    if (!provider || !signer || !plan) throw new Error('流动性不足');
    const principal = amount(arbAmount); const floor = amount(minProfit, true);
    const block = await latestBlock(provider);
    const beforePools = await Promise.all([poolSnapshot(provider, plan.first, block), poolSnapshot(provider, plan.second, block)]);
    const latest = buildArbitrageRoutes(beforePools, arbToken, principal).find(route => route.id === plan.id);
    if (!latest || latest.profit <= 0n || latest.profit < floor) throw new Error('利润不足');
    const inputToken = tokenContract(arbToken); const otherToken = tokenContract(latest.intermediateToken);
    const [beforeInput, beforeOther, allowance] = await Promise.all([inputToken.balanceOf(account, { blockTag: block }), otherToken.balanceOf(account, { blockTag: block }), inputToken.allowance(account, config.arbitrageur)]);
    if (beforeInput < principal) throw new Error('代币余额不足');
    if (allowance < principal) throw new Error('尚未授权');
    const arb = new Contract(config.arbitrageur, arbitrageAbi, signer);
    const args = [latest.first.dexAddress, latest.first.poolId, latest.second.dexAddress, latest.second.poolId, arbToken, principal, latest.intermediate * 995n / 1000n, floor, account] as const;
    await arb.execute.staticCall(...args);
    // Only one transaction is sent: it includes both swaps and the profit check.
    const transaction = await arb.execute(...args);
    setPendingHash(transaction.hash); setStatus('套利交易已提交，等待两次兑换在同一笔交易中确认。');
    const receipt = await transaction.wait() as ContractTransactionReceipt;
    const event = findEvent(receipt, config.arbitrageur, arbitrageAbi, 'ArbitrageExecuted');
    const firstSwap = findEvent(receipt, latest.first.dexAddress, dexAbi, 'Swapped');
    try {
      const [afterInput, afterOther, afterPools] = await Promise.all([
        inputToken.balanceOf(account, { blockTag: receipt.blockNumber }), otherToken.balanceOf(account, { blockTag: receipt.blockNumber }),
        Promise.all(beforePools.map(pool => poolSnapshot(provider, pool, receipt.blockNumber))),
      ]);
      setArbReport({ route: latest, hash: receipt.hash, block: receipt.blockNumber, gasFee: receipt.fee,
        intermediate: firstSwap?.args.amountOut ?? latest.intermediate, output: event?.args.output ?? principal + afterInput - beforeInput,
        profit: event?.args.profit ?? afterInput - beforeInput, beforeInput, afterInput, beforeOther, afterOther, beforePools, afterPools });
    } catch {
      setAlert({ title: '套利交易已确认', message: `套利已在链上成功，但暂时无法读取完整结果，请恢复连接后刷新。\n交易哈希：${receipt.hash}` });
    }
    return receipt;
  });

  const disabled = !account || Boolean(busy);
  const ownCount = pools.reduce((sum, pool) => sum + pool.positions.filter(position => sameAddress(position.owner, account)).length, 0);
  const poolOptions = pools.map(pool => <option key={poolKey(pool)} value={poolKey(pool)}>{poolLabel(pool)} · {tokenName(pool.tokenA)} / {tokenName(pool.tokenB)}</option>);
  const tokenOptions = tokens.map(token => <option key={token.address} value={token.address}>{token.label}</option>);
  const choosePool = (pool: PoolView) => { setSelectedKey(poolKey(pool)); setSwapToken(pool.tokenA); };

  const visiblePools = pools.filter(pool => poolFilter === 'all' || pool.dexKey === poolFilter);
  const positionEntries = pools.flatMap(pool => pool.positions.map(position => ({ pool, position }))).filter(({ position }) => positionFilter === 'all' || sameAddress(position.owner, account));
  const activePools = pools.filter(pool => pool.reserveA > 0n && pool.reserveB > 0n).length;
  const connected = Boolean(account) && !readFailed;
  const outputToken = selectedPool ? (sameAddress(swapToken, selectedPool.tokenA) ? selectedPool.tokenB : selectedPool.tokenA) : config.tokenB;

  return <div className="app-shell">
    <aside className="sidebar">
      <a className="sidebar-brand" href="#overview" aria-label="MiniDEX 首页"><span className="brand-mark"><Icon name="pools" /></span><span className="brand-name">mini<span>dex</span><small>YOUR ONCHAIN SPACE</small></span></a>
      <p className="sidebar-label">工作空间</p>
      <nav aria-label="主导航">{navigation.map(item => <a key={item.id} href={`#${item.id}`} aria-label={item.label} title={item.label} aria-current={activeSection === item.id ? 'location' : undefined} className={activeSection === item.id ? 'active' : ''} onClick={() => setActiveSection(item.id)}><Icon name={item.icon} /><span>{item.label}</span>{item.id === 'arbitrage' && <small>ATOMIC</small>}</a>)}</nav>
      <div className="sidebar-bottom"><div className="side-network"><span className={`live-dot ${connected ? 'online' : ''}`} /><div><strong>{connected ? '本地链已连接' : '等待钱包连接'}</strong><span>Ethereum · Chain {config.chainId}</span></div></div><p>每一笔交易，都由你掌控。<br />本地测试环境 · 测试资产</p><span className="sidebar-version">MiniDEX / COURSE 2026</span></div>
    </aside>
    <main className="page" aria-busy={Boolean(busy)}>
      <header className="topbar"><div className="breadcrumb">工作台 <Icon name="chevron" /><strong>{navigation.find(item => item.id === activeSection)?.label}</strong></div><div className="topbar-actions"><span className="network-pill"><span className={`live-dot ${connected ? 'online' : ''}`} />本地测试网络</span><button className={`wallet-button ${account ? 'is-connected' : ''}`} disabled={Boolean(busy)} onClick={() => void connect()} title={account || '连接 MetaMask'}><Icon name="wallet" />{account ? short(account) : '连接钱包'}{account && <span className="wallet-dot" />}</button></div></header>
      <section className="hero" id="overview"><div><p className="eyebrow">YOUR ONCHAIN WORKSPACE</p><h1>MiniDEX 控制台<span className="title-dot" aria-hidden="true">.</span></h1><p>从一笔兑换开始，探索流动性与链上机会。</p></div><a className="text-link" href="#trade" onClick={() => setActiveSection('trade')}>开始交易 <Icon name="arrow" /></a></section>
      <section className="metrics" aria-label="我的资产概览">
        <div className="metric-card"><div className="metric-top"><span>账户 ETH</span><span className="metric-icon eth-icon" aria-hidden="true">Ξ</span></div><strong>{balances.eth}</strong><div className="metric-bottom"><span>ETH</span><small>用于支付网络费</small></div></div>
        <div className="metric-card"><div className="metric-top"><span>Token A</span><TokenIcon address={config.tokenA} /></div><strong>{balances.a}</strong><div className="metric-bottom"><span>代币余额</span><small>ERC20</small></div></div>
        <div className="metric-card"><div className="metric-top"><span>Token B</span><TokenIcon address={config.tokenB} /></div><strong>{balances.b}</strong><div className="metric-bottom"><span>代币余额</span><small>ERC20</small></div></div>
        <div className="metric-card"><div className="metric-top"><span>我的仓位 NFT</span><span className="metric-icon nft-icon"><Icon name="nft" /></span></div><strong>{ownCount.toString().padStart(2, '0')}</strong><div className="metric-bottom"><span>活跃仓位</span><a href="#positions">查看仓位 <Icon name="arrow" /></a></div></div>
      </section>
      <div className={`status-bar ${busy ? 'working' : ''}`}><span className={busy ? 'spinner' : 'status-symbol'}>{!busy && <Icon name="info" />}</span><p className="status" role="status">{status}</p><span className="status-caption">{updated ? `区块 #${updated.block}` : `CHAIN ${config.chainId}`}</span></div>

      <section className="section" id="pools"><div className="section-title"><div><p className="eyebrow">LIQUIDITY MARKETS</p><h2>交易所与池子 <span className="count-badge">{pools.length}</span></h2><p>独立的储备，不同的价格。找到适合你的交易池。</p></div><div className="segmented" role="group" aria-label="筛选交易池">{[{ key: 'all', label: '全部池子' }, { key: 'dex1', label: 'DEX 1' }, { key: 'dex2', label: 'DEX 2' }].map(item => <button key={item.key} aria-pressed={poolFilter === item.key} className={poolFilter === item.key ? 'active' : ''} onClick={() => setPoolFilter(item.key)}>{item.label}</button>)}</div></div>
        <div className="pool-grid">{visiblePools.map(pool => <article className={`pool-card ${poolKey(pool) === selectedKey ? 'selected' : ''}`} key={poolKey(pool)}><div className="pool-head"><div className="pool-identity"><div className="token-pair"><TokenIcon address={pool.tokenA} /><TokenIcon address={pool.tokenB} /></div><div><h3>{poolLabel(pool)}</h3><span>{tokenName(pool.tokenA)} / {tokenName(pool.tokenB)}</span></div></div><span className={`dex-badge ${pool.dexKey}`}>{pool.reserveA > 0n && pool.reserveB > 0n ? '可交易' : '待注入流动性'}</span></div><div className="pool-price"><span>兑换价格</span><strong><small>1 A = </small>{price(pool)}<small> B</small></strong></div><div className="reserve"><div><span>{tokenName(pool.tokenA)} 储备</span><strong>{format(pool.reserveA)}</strong></div><div><span>{tokenName(pool.tokenB)} 储备</span><strong>{format(pool.reserveB)}</strong></div></div><div className="pool-meta"><span><Icon name="drop" />{pool.positions.length} 个 LP 仓位</span><span>手续费 <strong>0.30%</strong></span><span title={`创建时间：${date(pool.createdTimestamp)}\n合约：${pool.dexAddress}`}>{short(pool.dexAddress)}</span></div><button className={`pool-select ${poolKey(pool) === selectedKey ? 'is-selected' : ''}`} disabled={Boolean(busy)} onClick={() => choosePool(pool)}>{poolKey(pool) === selectedKey ? <><Icon name="check" />当前已选中</> : <>选择此池<Icon name="arrow" /></>}</button></article>)}</div>
        {visiblePools.length === 0 && <div className="empty empty-pools"><span className="empty-icon"><Icon name="pools" /></span><strong>{account ? '这个交易所还没有池子' : '连接钱包，查看链上交易池'}</strong><p>{account ? '选择两种代币，创建你的第一个流动性池。' : '连接后即可查看两个 DEX 的价格、储备与流动性。'}</p></div>}
        <div className="create-panel"><div className="create-heading"><span className="panel-icon"><Icon name="plus" /></span><div><h3>创建新的交易池</h3><p>同一币对也可以拥有多个独立池。</p></div></div><div className="create-pool"><label>交易所<select aria-label="创建池子的交易所" value={createDex} onChange={event => setCreateDex(event.target.value)}><option value="dex1">DEX 1</option><option value="dex2">DEX 2</option></select></label><label>代币一<select aria-label="池子代币一" value={poolToken0} onChange={event => setPoolToken0(event.target.value)}>{tokenOptions}</select></label><label>代币二<select aria-label="池子代币二" value={poolToken1} onChange={event => setPoolToken1(event.target.value)}>{tokenOptions}</select></label><button className="primary" disabled={disabled} onClick={() => void createPool()}><Icon name="plus" />创建交易池</button></div><p className="hint"><Icon name="info" />创建后添加流动性，首次存入的代币比例决定初始价格。</p></div>
      </section>

      <section className="section" id="trade"><div className="section-title"><div><p className="eyebrow">TRADE & PROVIDE</p><h2>让资产流动起来</h2><p>选择交易池，兑换代币，或成为流动性提供者。</p></div><span className="section-note"><span className={`live-dot ${connected && activePools > 0 ? 'online' : ''}`} />{activePools} 个可用交易池</span></div><div className="grid trading-grid">
        <article className="panel swap-panel"><div className="panel-heading"><div><span className="panel-kicker">SWAP</span><h2>兑换</h2></div><span className="panel-icon"><Icon name="swap" /></span></div><div className="form"><label>交易所与池子<select aria-label="兑换交易池" value={selectedKey} onChange={event => setSelectedKey(event.target.value)}>{poolOptions}</select></label><div className="amount-box"><div className="amount-box-head"><label htmlFor="swap-amount">数量</label><span>你支付</span></div><div className="amount-box-body"><input id="swap-amount" type="number" min="0" step="any" value={amountIn} onChange={event => setAmountIn(event.target.value)} /><label className="token-selector"><span className="sr-only">输入代币</span><TokenIcon address={swapToken} /><select value={swapToken} onChange={event => setSwapToken(event.target.value)}>{selectedPool ? [selectedPool.tokenA, selectedPool.tokenB].map(address => <option key={address} value={address}>{tokenName(address)}</option>) : tokenOptions}</select></label></div></div><div className="swap-direction"><button aria-label="切换兑换方向" title="切换兑换方向" disabled={disabled || !selectedPool} onClick={() => setSwapToken(outputToken)}><Icon name="swap" /></button></div><div className="amount-box output-box"><div className="amount-box-head"><span>预计收到</span><span>按当前池价估算</span></div><div className="amount-box-body"><strong>{format(quote, 6)}</strong><span className="output-token"><TokenIcon address={outputToken} />{tokenName(outputToken)}</span></div></div><div className="trade-costs"><span>交易手续费 <strong>0.30%</strong></span><span>滑点保护 <strong>0.50%</strong></span></div><button className="primary full-width" disabled={disabled || !selectedPool} onClick={() => void swap()}>兑换<Icon name="arrow" /></button></div><p className="hint">钱包确认后，兑换结果将自动同步到资产余额。</p></article>
        <article className="panel liquidity-panel"><div className="panel-heading"><div><span className="panel-kicker">PROVIDE LIQUIDITY</span><h2>添加流动性</h2></div><span className="panel-icon violet"><Icon name="drop" /></span></div><p>存入两种代币，获得代表你流动性份额的 NFT，并分享池中交易手续费。</p><div className="form"><label>交易所与池子<select aria-label="添加流动性的交易池" value={selectedKey} onChange={event => setSelectedKey(event.target.value)}>{poolOptions}</select></label><div className="liquidity-inputs"><label><span className="token-label"><TokenIcon address={selectedPool?.tokenA ?? config.tokenA} /><span>{selectedPool ? tokenName(selectedPool.tokenA) : 'Token A'} 数量</span></span><input type="number" min="0" step="any" aria-label={`${selectedPool ? tokenName(selectedPool.tokenA) : 'Token A'} 数量`} value={liquidityA} onChange={event => setLiquidityA(event.target.value)} /></label><span className="liquidity-plus"><Icon name="plus" /></span><label><span className="token-label"><TokenIcon address={selectedPool?.tokenB ?? config.tokenB} /><span>{selectedPool ? tokenName(selectedPool.tokenB) : 'Token B'} 数量</span></span><input type="number" min="0" step="any" aria-label={`${selectedPool ? tokenName(selectedPool.tokenB) : 'Token B'} 数量`} value={liquidityB} onChange={event => setLiquidityB(event.target.value)} /></label></div><div className="nft-receipt"><Icon name="nft" /><div><strong>每一份流动性，都有链上凭证</strong><span>包含池子、数量与创建时间 · 随时销毁取回资产</span></div></div><button className="primary full-width" disabled={disabled || !selectedPool} onClick={() => void addLiquidity()}>存入并铸造 NFT<Icon name="plus" /></button></div><p className="hint">已有流动性的池，实际存入数量按当前储备比例计算。</p></article>
        <article className="panel utility-panel"><div className="panel-heading"><div><span className="panel-kicker">FAUCET</span><h2>测试代币</h2></div><span className="panel-icon"><Icon name="wallet" /></span></div><p>每次领取 1000 个测试代币，开始你的第一笔交易。</p><div className="actions faucet-actions"><button disabled={disabled} onClick={() => void faucet(config.tokenA)}><TokenIcon address={config.tokenA} />领取 Token A<Icon name="plus" /></button><button disabled={disabled} onClick={() => void faucet(config.tokenB)}><TokenIcon address={config.tokenB} />领取 Token B<Icon name="plus" /></button></div><p className="hint">网络费需要使用本地账户中的测试 ETH。</p></article>
        <article className="panel utility-panel"><div className="panel-heading"><div><span className="panel-kicker">REDEEM POSITION</span><h2>手动销毁仓位 NFT</h2></div><span className="panel-icon amber"><Icon name="nft" /></span></div><p>凭 NFT 取回对应份额的两种代币与累计手续费。</p><div className="form two"><label>交易所<select value={positionDex} onChange={event => setPositionDex(event.target.value)}><option value="dex1">DEX 1</option><option value="dex2">DEX 2</option></select></label><label>NFT ID<input type="number" min="1" value={positionId} onChange={event => setPositionId(event.target.value)} /></label></div><button className="secondary full-width" disabled={disabled} onClick={() => void removePosition(positionDex, positionId)}>销毁 NFT 并取回资产<Icon name="arrow" /></button></article>
      </div></section>

      <section className="section" id="positions"><div className="section-title"><div><p className="eyebrow">YOUR LIQUIDITY, ONCHAIN</p><h2>池子流动性来源与我的 NFT</h2><p>每一个仓位，都有可追溯的链上记录。</p></div><div className="segmented" role="group" aria-label="筛选 NFT 仓位"><button className={positionFilter === 'all' ? 'active' : ''} aria-pressed={positionFilter === 'all'} onClick={() => setPositionFilter('all')}>全部仓位</button><button className={positionFilter === 'mine' ? 'active' : ''} aria-pressed={positionFilter === 'mine'} onClick={() => setPositionFilter('mine')}>我的 NFT <span>{ownCount}</span></button></div></div><div className="table-wrap"><table><thead><tr><th>DEX / 池子 / NFT</th><th>持有人</th><th>初始存入</th><th>份额占比</th><th>当前可取回</th><th>创建时间</th><th>仓位信息</th><th>操作</th></tr></thead><tbody>{positionEntries.map(({ pool, position }) => <tr key={`${pool.dexKey}-${position.id}`}><td><span className="position-name"><span className="nft-mini"><Icon name="nft" /></span><span>{poolLabel(pool)}<small>NFT #{position.id.toString()}</small></span></span></td><td title={position.owner}>{sameAddress(position.owner, account) ? <span className="owner-tag">我的仓位</span> : <span className="address-text">{short(position.owner)}</span>}</td><td>{format(position.depositedA)} <small>{tokenName(pool.tokenA)}</small><br />{format(position.depositedB)} <small>{tokenName(pool.tokenB)}</small></td><td><strong>{ratio(position.liquidity * 100n, pool.totalLiquidity)}%</strong><span className="share-track" aria-hidden="true"><span style={{ width: `${Math.min(100, Number(position.liquidity * 10000n / pool.totalLiquidity) / 100)}%` }} /></span></td><td>{format(pool.reserveA * position.liquidity / pool.totalLiquidity)} <small>{tokenName(pool.tokenA)}</small><br />{format(pool.reserveB * position.liquidity / pool.totalLiquidity)} <small>{tokenName(pool.tokenB)}</small></td><td className="date-cell">{date(position.createdTimestamp)}</td><td><button className="table-link" onClick={() => setAlert({ title: `NFT #${position.id} 的链上信息`, kind: 'info', message: `所属池：${poolLabel(pool)}\n存入：${format(position.depositedA)} ${tokenName(pool.tokenA)} / ${format(position.depositedB)} ${tokenName(pool.tokenB)}\n流动性份额：${format(position.liquidity)}\n创建时间：${date(position.createdTimestamp)}\n持有人：${position.owner}`, details: position.metadataUri })}>查看详情<Icon name="chevron" /></button></td><td>{sameAddress(position.owner, account) ? <button className="redeem-button" disabled={disabled} onClick={() => void removePosition(pool.dexKey, position.id.toString())}>销毁并取回</button> : <span className="muted">—</span>}</td></tr>)}</tbody></table>{positionEntries.length === 0 && <div className="empty"><span className="empty-icon"><Icon name="nft" /></span><strong>{positionFilter === 'mine' ? '你还没有流动性 NFT' : '暂无活跃流动性仓位'}</strong><p>向交易池添加流动性后，仓位会出现在这里。</p></div>}</div><p className="table-scroll-hint">左右滑动，可查看完整的仓位信息。</p></section>

      <section className="section bonus-section" id="arbitrage"><div className="section-title"><div><p className="eyebrow"><Icon name="bolt" />FIND THE SPREAD</p><h2>原子套利监控 <span className="atomic-tag" aria-hidden="true">ATOMIC</span></h2><p>比较所有同币对池的完整兑换结果，发现跨池价格机会。</p></div><button className="secondary" disabled={disabled} onClick={() => void refresh(true)}><Icon name="refresh" />立即刷新</button></div>
        <div className="arbitrage-workspace"><div className="monitor-bar"><label className="check-label"><input type="checkbox" checked={autoRefresh} onChange={event => setAutoRefresh(event.target.checked)} /><span className="toggle-track" aria-hidden="true" />每 5 秒刷新</label><span className="monitor-timestamp">{updated ? `区块 #${updated.block} · ${updated.time} 更新` : '连接钱包后开始监控'}</span><span className={`monitor-state ${readFailed ? 'has-error' : ''}`}><span className={`live-dot ${connected && autoRefresh ? 'online' : ''}`} />{readFailed ? '读取失败，请检查节点' : !account ? '等待连接' : autoRefresh ? '监控中' : '自动刷新已暂停'}</span></div>
          <div className="form arb-inputs"><label>本金代币<select value={arbToken} disabled={Boolean(busy)} onChange={event => { setArbToken(event.target.value); setArbAllowance(0n); setRouteId('best'); }}>{tokenOptions}</select></label><label>套利本金<input type="number" min="0" step="any" value={arbAmount} disabled={Boolean(busy)} onChange={event => setArbAmount(event.target.value)} /></label><label>最低利润（本金代币）<input type="number" min="0" step="any" value={minProfit} disabled={Boolean(busy)} onChange={event => setMinProfit(event.target.value)} /></label><label>路线选择<select value={routeId} disabled={Boolean(busy)} onChange={event => setRouteId(event.target.value)}><option value="best">自动选择利润最高的路线</option>{routes.map(route => <option key={route.id} value={route.id}>{poolLabel(route.first)} → {poolLabel(route.second)}</option>)}</select></label></div>
          <div className="route-summary"><div className="route-summary-heading"><span className="route-eyebrow">{routeId === 'best' ? '当前最优路线' : '已选路线'}</span><span className={`opportunity-tag ${opportunity ? 'available' : ''}`}>{opportunity ? '满足盈利条件' : '等待套利机会'}</span></div>{plan ? <><div className="route-visual"><div className="route-node"><span className="route-step">01</span><div><small>{tokenName(arbToken)} → {tokenName(plan.intermediateToken)}</small><strong>{poolLabel(plan.first)}</strong></div></div><div className="route-connector"><Icon name="arrow" /><span>同一笔交易</span></div><div className="route-node"><span className="route-step">02</span><div><small>{tokenName(plan.intermediateToken)} → {tokenName(arbToken)}</small><strong>{poolLabel(plan.second)}</strong></div></div></div><div className="reserve route-metrics"><div><span>预计中间兑换数量</span><strong>{format(plan.intermediate, 6)}<small>{tokenName(plan.intermediateToken)}</small></strong></div><div><span>预计回收本金代币</span><strong>{format(plan.output, 6)}<small>{tokenName(arbToken)}</small></strong></div><div className="profit-metric"><span>预计代币利润</span><strong className={plan.profit > 0n ? 'profit' : 'loss'}>{plan.profit > 0n ? '+' : ''}{format(plan.profit, 6)}<small>{tokenName(arbToken)}</small></strong></div></div></> : <div className="route-empty"><Icon name="swap" /><strong>暂无可用套利路线</strong><p>连接钱包后，自动比较至少两个有流动性的同币对池。</p></div>}<p className="hint">{!arbInput || profitFloor === undefined ? '请输入有效的本金和非负最低利润。' : opportunity ? '报价已包含两次手续费和价格冲击，可准备授权后执行。' : '当前路线未达到盈利要求，可调整本金、切换路线或等待价格变化。'} 利润未扣除 ETH 网络费。</p></div>
          <div className="arb-actions"><button className={`secondary ${approved ? 'approved-button' : ''}`} disabled={disabled || !arbInput || approved} onClick={() => void approveArbitrage()}><Icon name={approved ? 'check' : 'wallet'} />{approved ? '① 授权额度已足够' : '① 准备代币授权'}</button><button className="primary" disabled={disabled || !opportunity || !approved || readFailed} onClick={() => void arbitrage()}><Icon name="bolt" />② 执行原子套利（一笔交易）</button></div><div className="atomic-note"><Icon name="link" /><p>先授权，再执行。两次兑换、利润检查与资产返还在同一笔套利交易中完成，任一步失败都会整体回滚。中间输出滑点保护为 0.50%。</p></div>
          {pendingHash && <p className="transaction-hash">待确认套利交易：<code>{pendingHash}</code></p>}
          {routes.length > 0 && <details className="routes"><summary>查看全部 {routes.length} 条路线（按预计利润排序）<Icon name="chevron" /></summary><div className="table-wrap"><table><thead><tr><th>第一次兑换的池</th><th>第二次兑换的池</th><th>范围</th><th>预计回收</th><th>预计利润（{tokenName(arbToken)}）</th></tr></thead><tbody>{routes.map(route => <tr className={plan?.id === route.id ? 'chosen-route' : ''} key={route.id}><td>{poolLabel(route.first)}</td><td>{poolLabel(route.second)}</td><td><span className="route-scope">{route.first.dexKey === route.second.dexKey ? '同一 DEX' : '跨 DEX'}</span></td><td>{format(route.output, 6)}</td><td className={route.profit > 0n ? 'profit' : 'loss'}>{route.profit > 0n ? '+' : ''}{format(route.profit, 6)}</td></tr>)}</tbody></table></div></details>}
        </div>
        {arbReport && <div className="arb-result"><div className="result-heading"><span className="result-check"><Icon name="check" /></span><div><h3>最近一次套利已确认 · 一笔交易完成两次兑换</h3><p>{poolLabel(arbReport.route.first)} → {poolLabel(arbReport.route.second)} · 区块 #{arbReport.block}</p></div></div><p className="transaction-hash"><Icon name="link" /><code>{arbReport.hash}</code></p><div className="arb-report"><div><span>投入本金</span><strong>{format(arbReport.route.amount, 6)}<small>{tokenName(arbReport.route.tokenIn)}</small></strong></div><div><span>实际中间兑换数量</span><strong>{format(arbReport.intermediate, 6)}<small>{tokenName(arbReport.route.intermediateToken)}</small></strong></div><div><span>实际回收</span><strong>{format(arbReport.output, 6)}<small>{tokenName(arbReport.route.tokenIn)}</small></strong></div><div><span>实际代币利润（未扣 ETH 费）</span><strong className="profit">+{format(arbReport.profit, 6)}<small>{tokenName(arbReport.route.tokenIn)}</small></strong></div><div><span>钱包本金代币余额</span><strong>{format(arbReport.beforeInput)} → {format(arbReport.afterInput)}</strong></div><div><span>钱包中间代币余额</span><strong>{format(arbReport.beforeOther)} → {format(arbReport.afterOther)}</strong></div><div><span>本次套利网络费</span><strong>{format(arbReport.gasFee, 9)}<small>ETH</small></strong></div></div><div className="table-wrap"><table><thead><tr><th>池子</th><th>价格（Token B / Token A）</th><th>池内第一种代币储备</th><th>池内第二种代币储备</th></tr></thead><tbody>{arbReport.beforePools.map((before, index) => { const after = arbReport.afterPools[index]; return <tr key={poolKey(before)}><td>{poolLabel(before)}</td><td>{price(before)} → {price(after)}</td><td>{tokenName(before.tokenA)}：{format(before.reserveA)} → {format(after.reserveA)}</td><td>{tokenName(before.tokenB)}：{format(before.reserveB)} → {format(after.reserveB)}</td></tr>; })}</tbody></table></div></div>}
      </section>
      <footer className="page-footer"><span className="footer-brand"><Icon name="pools" />MiniDEX</span><span>基于以太坊的去中心化交易演示</span><span>本地测试环境</span></footer>
    </main>
    {alert && <div className="modal-backdrop" onClick={() => setAlert(undefined)}><section ref={dialogRef} className={`modal modal-${alert.kind ?? 'info'}`} role="alertdialog" aria-modal="true" aria-labelledby="dialog-title" aria-describedby="dialog-message" onClick={event => event.stopPropagation()}><span className="modal-symbol"><Icon name={alert.kind === 'error' ? 'alert' : alert.kind === 'success' ? 'check' : 'info'} /></span><h2 id="dialog-title">{alert.title}</h2><p id="dialog-message">{alert.message}</p>{alert.details && <details className="metadata-details"><summary>查看原始 NFT 元数据</summary><pre>{alert.details}</pre></details>}<button className="primary" ref={closeButton} onClick={() => setAlert(undefined)}>知道了</button></section></div>}
  </div>;
}

export default App;
