import { randomInt } from "node:crypto";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import hre from "hardhat";

async function main() {
  const { ethers } = await hre.network.create();
  const deployment = JSON.parse(readFileSync(resolve(process.cwd(), "../frontend/src/deployments.local.json"), "utf8"));
  const tokenA = await ethers.getContractAt("MockERC20", deployment.tokenA);
  const tokenB = await ethers.getContractAt("MockERC20", deployment.tokenB);
  const rounds = Number(process.env.SIMULATION_ROUNDS ?? 3);
  if (!Number.isInteger(rounds) || rounds < 1 || rounds > 100) throw new Error("SIMULATION_ROUNDS must be an integer from 1 to 100");
  const addresses: string[] = await ethers.provider.send("eth_accounts", []);
  if (addresses.length < 20) throw new Error("The local node must expose at least 20 accounts");
  const users = await Promise.all(addresses.slice(0, 20).map(address => ethers.getSigner(address)));
  const markets: { dex: any; nft: any; id: number; label: string }[] = [];
  for (const [index, address] of [deployment.dex1, deployment.dex2].entries()) {
    const dex = await ethers.getContractAt("MiniDEX", address);
    const nft = await ethers.getContractAt("LiquidityPositionNFT", await dex.positionNFT());
    for (let id = 1; id <= Number(await dex.poolCount()); id++) {
      const pool = await dex.getPool(id);
      const samePair = [pool.tokenA, pool.tokenB].map(token => token.toLowerCase()).sort().join() ===
        [deployment.tokenA, deployment.tokenB].map(token => token.toLowerCase()).sort().join();
      if (samePair && pool.reserveA > 0n && pool.reserveB > 0n) markets.push({ dex, nft, id, label: `DEX ${index + 1} / pool #${id}` });
    }
  }
  if (markets.length < 2) throw new Error("Deploy and seed at least two A/B pools first");
  const printPrices = async (title: string) => {
    console.log(title);
    for (const market of markets) {
      const pool = await market.dex.getPool(market.id);
      const aFirst = pool.tokenA.toLowerCase() === deployment.tokenA.toLowerCase();
      const [a, b] = aFirst ? [pool.reserveA, pool.reserveB] : [pool.reserveB, pool.reserveA];
      console.log(`${market.label}: A=${ethers.formatEther(a)}, B=${ethers.formatEther(b)}, B/A=${ethers.formatEther(b * 10n ** 18n / a)}`);
    }
  };
  await printPrices("Before random trading:");
  const positions = new Map<string, { dex: any; id: bigint }>();
  const activity = new Map(markets.map(market => [market.label, 0]));
  let additions = 0; let removals = 0;
  for (const user of users) {
    await (await tokenA.faucet(user.address, ethers.parseEther("1000"))).wait();
    await (await tokenB.faucet(user.address, ethers.parseEther("1000"))).wait();
  }
  for (let round = 0; round < rounds; round++) {
    for (const user of users) {
      const market = markets[randomInt(markets.length)];
      const pool = await market.dex.getPool(market.id);
      if (round === 0) {
        const first = ethers.parseEther(String(randomInt(10, 31)));
        const second = first * pool.reserveB / pool.reserveA;
        const firstToken = pool.tokenA.toLowerCase() === deployment.tokenA.toLowerCase() ? tokenA : tokenB;
        const secondToken = firstToken === tokenA ? tokenB : tokenA;
        await (await (firstToken.connect(user) as any).approve(await market.dex.getAddress(), first)).wait();
        await (await (secondToken.connect(user) as any).approve(await market.dex.getAddress(), second)).wait();
        const id = await market.nft.nextTokenId();
        await (await market.dex.connect(user).addLiquidity(market.id, first, second, user.address)).wait();
        positions.set(user.address.toLowerCase(), { dex: market.dex, id }); additions++;
      }
      const input = randomInt(2) === 0 ? tokenA : tokenB;
      const value = ethers.parseEther(String(randomInt(5, 51)));
      await (await (input.connect(user) as any).approve(await market.dex.getAddress(), value)).wait();
      await (await market.dex.connect(user).swap(market.id, await input.getAddress(), value, 0, user.address)).wait();
      activity.set(market.label, activity.get(market.label)! + 1);
      const position = positions.get(user.address.toLowerCase());
      if (round > 0 && position && randomInt(3) === 0) {
        await (await position.dex.connect(user).removeLiquidity(position.id)).wait();
        positions.delete(user.address.toLowerCase()); removals++;
      }
    }
    console.log(`Round ${round + 1}/${rounds}: 20 random swaps completed`);
  }
  await printPrices("After random trading:");
  for (const [label, swaps] of activity) console.log(`${label}: ${swaps} swaps`);
  console.log(`Simulated 20 users: ${rounds * 20} random swaps, ${additions} liquidity additions, ${removals} removals across ${markets.length} pools.`);
}

main().catch(error => { console.error(error); process.exitCode = 1; });
