import { expect } from "chai";
import hre from "hardhat";

const { ethers, networkHelpers } = await hre.network.create();

describe("MiniDEX", function () {
  async function deployFixture() {
    const [owner, trader] = await ethers.getSigners();
    const supply = ethers.parseEther("1000000");
    const tokenA = await ethers.deployContract("MockERC20", ["Token A", "TKA", supply]);
    const tokenB = await ethers.deployContract("MockERC20", ["Token B", "TKB", supply]);
    const nft = await ethers.deployContract("LiquidityPositionNFT");
    const dex = await ethers.deployContract("MiniDEX", [await nft.getAddress()]);
    const arb = await ethers.deployContract("Arbitrageur");
    await Promise.all([tokenA.waitForDeployment(), tokenB.waitForDeployment(), nft.waitForDeployment(), dex.waitForDeployment(), arb.waitForDeployment()]);
    await (await nft.setMinter(await dex.getAddress())).wait();
    await (await dex.createPool(await tokenA.getAddress(), await tokenB.getAddress())).wait();
    await (await tokenA.approve(await dex.getAddress(), ethers.parseEther("1000"))).wait();
    await (await tokenB.approve(await dex.getAddress(), ethers.parseEther("1000"))).wait();
    await (await dex.addLiquidity(1, ethers.parseEther("500"), ethers.parseEther("500"), owner.address)).wait();
    await (await tokenA.transfer(trader.address, ethers.parseEther("100"))).wait();
    return { owner, trader, tokenA, tokenB, nft, dex, arb };
  }

  it("creates a pool and mints a liquidity NFT", async function () {
    const { dex, nft } = await networkHelpers.loadFixture(deployFixture);
    const pool = await dex.getPool(1);
    expect(pool.reserveA).to.equal(ethers.parseEther("500"));
    expect(pool.reserveB).to.equal(ethers.parseEther("500"));
    expect(await nft.ownerOf(1)).to.equal((await ethers.getSigners())[0].address);
    expect(await nft.tokenURI(1)).to.contain('"poolId":"1"');
    expect((await dex.getPoolPositionIds(1)).length).to.equal(1);
  });

  it("swaps using the constant product formula", async function () {
    const { trader, tokenA, tokenB, dex } = await networkHelpers.loadFixture(deployFixture);
    const amount = ethers.parseEther("10");
    const traderTokenA = tokenA.connect(trader) as any;
    const traderDex = dex.connect(trader) as any;
    await (await traderTokenA.approve(await dex.getAddress(), amount)).wait();
    const before = await tokenB.balanceOf(trader.address);
    await (await traderDex.swap(1, await tokenA.getAddress(), amount, 0, trader.address)).wait();
    expect(await tokenB.balanceOf(trader.address)).to.be.gt(before);
  });

  it("removes liquidity by burning the NFT", async function () {
    const { owner, nft, dex, tokenA } = await networkHelpers.loadFixture(deployFixture);
    const before = await tokenA.balanceOf(owner.address);
    await (await dex.removeLiquidity(1)).wait();
    expect(await tokenA.balanceOf(owner.address)).to.be.gt(before);
    await expect(nft.ownerOf(1)).to.revert(ethers);
  });

  it("creates independent pools for the same pair in either token order", async function () {
    const { owner, tokenA, tokenB, dex } = await networkHelpers.loadFixture(deployFixture);
    const initial = Array.from(await dex.getPool(1));
    await (await dex.createPool(await tokenA.getAddress(), await tokenB.getAddress())).wait();
    await (await dex.createPool(await tokenB.getAddress(), await tokenA.getAddress())).wait();
    expect(await dex.getPoolsByPair(await tokenB.getAddress(), await tokenA.getAddress())).to.deep.equal([1n, 2n, 3n]);
    await (await dex.addLiquidity(2, ethers.parseEther("100"), ethers.parseEther("200"), owner.address)).wait();
    await (await dex.swap(2, await tokenA.getAddress(), ethers.parseEther("1"), 0, owner.address)).wait();
    await (await dex.removeLiquidity(2)).wait();
    expect(Array.from(await dex.getPool(1))).to.deep.equal(initial);
    expect((await dex.getPool(2)).totalLiquidity).to.equal(0n);
    expect((await dex.getPool(3)).reserveA).to.equal(0n);
  });

  async function arbitrageFixture() {
    const fixture = await deployFixture();
    const { owner, tokenA, tokenB, dex, arb, trader } = fixture;
    const nft2 = await ethers.deployContract("LiquidityPositionNFT");
    const dex2 = await ethers.deployContract("MiniDEX", [await nft2.getAddress()]);
    await (await nft2.setMinter(await dex2.getAddress())).wait();
    for (const market of [dex, dex2]) {
      await (await market.createPool(await tokenA.getAddress(), await tokenB.getAddress())).wait();
      const id = await market.poolCount();
      const pool = await market.getPool(id);
      const aFirst = pool.tokenA.toLowerCase() === (await tokenA.getAddress()).toLowerCase();
      await (await tokenA.approve(await market.getAddress(), ethers.MaxUint256)).wait();
      await (await tokenB.approve(await market.getAddress(), ethers.MaxUint256)).wait();
      await (await market.addLiquidity(id, ethers.parseEther(aFirst ? "1000" : "500"), ethers.parseEther(aFirst ? "500" : "1000"), owner.address)).wait();
    }
    await (await (tokenA.connect(trader) as any).approve(await arb.getAddress(), ethers.MaxUint256)).wait();
    await (await tokenB.transfer(trader.address, ethers.parseEther("100"))).wait();
    await (await (tokenB.connect(trader) as any).approve(await arb.getAddress(), ethers.MaxUint256)).wait();
    return { ...fixture, dex2 };
  }

  it("executes both cross-DEX swaps in one transaction and leaves donated dust untouched", async function () {
    const { trader, dex, dex2, tokenA, tokenB, arb } = await networkHelpers.loadFixture(arbitrageFixture);
    const value = ethers.parseEther("10");
    const dustA = ethers.parseEther("5"); const dustB = ethers.parseEther("7");
    await (await tokenA.transfer(await arb.getAddress(), dustA)).wait();
    await (await tokenB.transfer(await arb.getAddress(), dustB)).wait();
    const before = await tokenA.balanceOf(trader.address);
    const nonce = await ethers.provider.send("eth_getTransactionCount", [trader.address, "latest"]);
    const receipt = await (await (arb.connect(trader) as any).execute(await dex.getAddress(), 1, await dex2.getAddress(), 1, await tokenA.getAddress(), value, 0, ethers.parseEther("1"), trader.address)).wait();
    const swaps = receipt.logs.flatMap((log: any) => {
      try { const event = dex.interface.parseLog(log); return event?.name === "Swapped" ? [log] : []; } catch { return []; }
    });
    expect(swaps).to.have.length(2);
    expect(swaps.every((log: any) => log.transactionHash === receipt.hash)).to.equal(true);
    expect(BigInt(await ethers.provider.send("eth_getTransactionCount", [trader.address, "latest"])) - BigInt(nonce)).to.equal(1n);
    const event = receipt.logs.map((log: any) => { try { return arb.interface.parseLog(log); } catch { return null; } }).find((log: any) => log?.name === "ArbitrageExecuted");
    expect(event.args.output).to.equal(value + event.args.profit);
    expect(await tokenA.balanceOf(trader.address)).to.equal(before + event.args.profit);
    expect(event.args.profit).to.be.gte(ethers.parseEther("1"));
    expect(await tokenA.balanceOf(await arb.getAddress())).to.equal(dustA);
    expect(await tokenB.balanceOf(await arb.getAddress())).to.equal(dustB);
  });

  it("arbitrages two different pools in the same DEX", async function () {
    const { trader, dex, tokenA, arb } = await networkHelpers.loadFixture(arbitrageFixture);
    const before = await tokenA.balanceOf(trader.address);
    await (await (arb.connect(trader) as any).execute(await dex.getAddress(), 1, await dex.getAddress(), 2, await tokenA.getAddress(), ethers.parseEther("10"), 0, 1, trader.address)).wait();
    expect(await tokenA.balanceOf(trader.address)).to.be.gt(before);
  });

  it("also supports Token B as the arbitrage principal", async function () {
    const { trader, dex, dex2, tokenB, arb } = await networkHelpers.loadFixture(arbitrageFixture);
    const before = await tokenB.balanceOf(trader.address);
    await (await (arb.connect(trader) as any).execute(await dex2.getAddress(), 1, await dex.getAddress(), 1, await tokenB.getAddress(), ethers.parseEther("10"), 0, 1, trader.address)).wait();
    expect(await tokenB.balanceOf(trader.address)).to.be.gt(before);
  });

  it("rolls back both pools and token balances when a mined arbitrage cannot meet its profit floor", async function () {
    const { trader, dex, dex2, tokenA, tokenB, arb } = await networkHelpers.loadFixture(arbitrageFixture);
    const before = [Array.from(await dex.getPool(1)), Array.from(await dex2.getPool(1)), await tokenA.balanceOf(trader.address), await tokenB.balanceOf(trader.address)];
    const block = BigInt(await ethers.provider.send("eth_blockNumber", []));
    await expect((arb.connect(trader) as any).execute(await dex.getAddress(), 1, await dex2.getAddress(), 1, await tokenA.getAddress(), ethers.parseEther("10"), 0, ethers.parseEther("1000"), trader.address, { gasLimit: 1000000 })).to.revert(ethers);
    expect(BigInt(await ethers.provider.send("eth_blockNumber", []))).to.equal(block + 1n);
    expect([Array.from(await dex.getPool(1)), Array.from(await dex2.getPool(1)), await tokenA.balanceOf(trader.address), await tokenB.balanceOf(trader.address)]).to.deep.equal(before);
    expect(await tokenA.balanceOf(await arb.getAddress())).to.equal(0n);
    expect(await tokenB.balanceOf(await arb.getAddress())).to.equal(0n);
  });
});
