import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, expect, test, vi } from 'vitest';
import App from './App';

afterEach(() => { cleanup(); delete window.ethereum; });

test('renders the MiniDEX console', () => {
  render(<App />);
  expect(screen.getByRole('heading', { name: 'MiniDEX 控制台' })).toBeInTheDocument();
  expect(screen.getByRole('button', { name: '连接钱包' })).toBeInTheDocument();
  expect(screen.getByRole('heading', { name: '原子套利监控' })).toBeInTheDocument();
});

test('creates pools by token name rather than requiring an address', () => {
  render(<App />);
  expect(screen.getByLabelText('池子代币一')).toHaveDisplayValue('Token A');
  expect(screen.getByLabelText('池子代币二')).toHaveDisplayValue('Token B');
  expect(screen.queryByPlaceholderText('Token 地址 1')).not.toBeInTheDocument();
});

test('shows a readable popup when the wallet rejects an action', async () => {
  window.ethereum = { request: vi.fn(async ({ method }) => {
    if (method === 'eth_chainId') return '0x7a69';
    throw { code: 4001, message: 'raw wallet rejection payload' };
  }) };
  render(<App />);
  fireEvent.click(screen.getByRole('button', { name: '连接钱包' }));
  expect(await screen.findByRole('alertdialog')).toHaveTextContent('你已取消钱包操作');
  expect(screen.queryByText(/raw wallet rejection payload/)).not.toBeInTheDocument();
  fireEvent.click(screen.getByRole('button', { name: '知道了' }));
  expect(screen.queryByRole('alertdialog')).not.toBeInTheDocument();
});
