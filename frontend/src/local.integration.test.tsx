import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { expect, test } from 'vitest';
import { Interface, parseEther } from 'ethers';
import App from './App';
import deployments from './deployments.local.json';

// Opt in against an unlocked local node; snapshot/revert preserves the demo state.
test.skipIf(!process.env.LOCAL_RPC_SMOKE)('creates a repeated pair, shows a balance popup and sends one atomic arbitrage transaction', async () => {
  let id = 0;
  const rpc = async (method: string, params: unknown[] = []) => {
    const response = await fetch('http://127.0.0.1:8545', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id: ++id, method, params }) });
    const body = await response.json();
    if (body.error) throw body.error;
    return body.result;
  };
  const snapshot = await rpc('evm_snapshot');
  const accounts = await rpc('eth_accounts');
  const dexInterface = new Interface(['function poolCount() view returns (uint256)']);
  const nextPool = Number(BigInt(await rpc('eth_call', [{ to: deployments.dex1, data: dexInterface.encodeFunctionData('poolCount') }, 'latest']))) + 1;
  const newHeading = `DEX 1 / 池 #${nextPool}`;
  const sends: { to: string; data: string }[] = [];
  window.ethereum = { request: async ({ method, params }) => {
    if (method === 'eth_requestAccounts' || method === 'eth_accounts') return [accounts[1]];
    if (method === 'eth_sendTransaction') sends.push((params as { to: string; data: string }[])[0]);
    return rpc(method, params);
  } };
  try {
    const tokenInterface = new Interface(['function faucet(address,uint256)']);
    for (const to of [deployments.tokenA, deployments.tokenB]) {
      await rpc('eth_sendTransaction', [{ from: accounts[0], to, data: tokenInterface.encodeFunctionData('faucet', [accounts[1], parseEther('1000')]) }]);
    }
    render(<App />);
    fireEvent.click(screen.getByRole('checkbox', { name: '每 5 秒刷新' }));
    fireEvent.click(screen.getByRole('button', { name: '连接钱包' }));
    await screen.findByRole('heading', { name: 'DEX 2 / 池 #2' }, { timeout: 10000 });
    fireEvent.click(screen.getByRole('button', { name: '创建交易池' }));
    expect(await screen.findByRole('alertdialog', {}, { timeout: 10000 })).toHaveTextContent('交易池已创建');
    fireEvent.click(screen.getByRole('button', { name: '知道了' }));
    await screen.findByRole('heading', { name: newHeading });
    expect(screen.getByLabelText('添加流动性的交易池')).toHaveValue(`dex1-${nextPool}`);
    fireEvent.change(screen.getByLabelText('Token A 数量'), { target: { value: '100' } });
    fireEvent.change(screen.getByLabelText('Token B 数量'), { target: { value: '200' } });
    await waitFor(() => expect(screen.getByRole('button', { name: '存入并铸造 NFT' })).toBeEnabled());
    fireEvent.click(screen.getByRole('button', { name: '存入并铸造 NFT' }));
    await waitFor(() => expect(within(screen.getByRole('heading', { name: newHeading }).closest('article')!).getByText('200')).toBeInTheDocument(), { timeout: 10000 });
    const swapPanel = within(screen.getByRole('heading', { name: '兑换' }).closest('article')!);
    fireEvent.change(swapPanel.getByLabelText('数量'), { target: { value: '1000000000000' } });
    await waitFor(() => expect(swapPanel.getByRole('button', { name: '兑换' })).toBeEnabled());
    fireEvent.click(swapPanel.getByRole('button', { name: '兑换' }));
    expect(await screen.findByRole('alertdialog')).toHaveTextContent('代币余额不足');
    fireEvent.click(screen.getByRole('button', { name: '知道了' }));
    await waitFor(() => expect(screen.getByRole('button', { name: '① 准备代币授权' })).toBeEnabled());
    fireEvent.click(screen.getByRole('button', { name: '① 准备代币授权' }));
    await screen.findByRole('button', { name: '① 授权额度已足够' }, { timeout: 10000 });
    const execute = screen.getByRole('button', { name: '② 执行原子套利（一笔交易）' });
    await waitFor(() => expect(execute).toBeEnabled());
    const before = sends.length;
    fireEvent.click(execute);
    await screen.findByRole('heading', { name: '最近一次套利已确认 · 一笔交易完成两次兑换' }, { timeout: 10000 });
    expect(sends.length - before).toBe(1);
    expect(sends.at(-1)!.to.toLowerCase()).toBe(deployments.arbitrageur.toLowerCase());
    expect(screen.getByText('实际代币利润（未扣 ETH 费）')).toBeInTheDocument();
  } finally {
    cleanup(); delete window.ethereum;
    await rpc('evm_revert', [snapshot]);
  }
}, 60000);
