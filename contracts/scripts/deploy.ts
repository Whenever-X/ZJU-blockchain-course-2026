import { writeFileSync } from "node:fs";
import { resolve } from "node:path";
import hre from "hardhat";

async function main() {
  const { ethers } = await hre.network.create();
  const [deployer] = await ethers.getSigners();
  const supply = ethers.parseEther("1000000");

  const tokenA = await ethers.deployContract("MockERC20", ["Demo Token A", "TKA", supply]);
  const tokenB = await ethers.deployContract("MockERC20", ["Demo Token B", "TKB", supply]);
  await tokenA.waitForDeployment();
  await tokenB.waitForDeployment();

  const nft1 = await ethers.deployContract("LiquidityPositionNFT");
  const nft2 = await ethers.deployContract("LiquidityPositionNFT");
  await nft1.waitForDeployment();
  await nft2.waitForDeployment();

  const dex1 = await ethers.deployContract("MiniDEX", [await nft1.getAddress()]);
  const dex2 = await ethers.deployContract("MiniDEX", [await nft2.getAddress()]);
  await dex1.waitForDeployment();
  await dex2.waitForDeployment();
  await (await nft1.setMinter(await dex1.getAddress())).wait();
  await (await nft2.setMinter(await dex2.getAddress())).wait();

  // Each DEX has two independent A/B pools, with deliberately different prices.
  const seeds = [
    { dex: dex1, label: "DEX 1", reserves: [["100000", "100000"], ["60000", "90000"]] },
    { dex: dex2, label: "DEX 2", reserves: [["200000", "100000"], ["100000", "80000"]] },
  ];
  for (const { dex, label, reserves } of seeds) {
    await (await tokenA.approve(await dex.getAddress(), supply)).wait();
    await (await tokenB.approve(await dex.getAddress(), supply)).wait();
    for (const [a, b] of reserves) {
      await (await dex.createPool(await tokenA.getAddress(), await tokenB.getAddress())).wait();
      const id = await dex.poolCount();
      const pool = await dex.getPool(id);
      const aFirst = pool.tokenA.toLowerCase() === (await tokenA.getAddress()).toLowerCase();
      const [first, second] = aFirst ? [a, b] : [b, a];
      await (await dex.addLiquidity(id, ethers.parseEther(first), ethers.parseEther(second), deployer.address)).wait();
      console.log(`${label} pool #${id}: ${a} Token A / ${b} Token B`);
    }
  }

  const arbitrageur = await ethers.deployContract("Arbitrageur");
  await arbitrageur.waitForDeployment();

  const deployment = {
    chainId: Number((await ethers.provider.getNetwork()).chainId),
    deployer: deployer.address,
    tokenA: await tokenA.getAddress(),
    tokenB: await tokenB.getAddress(),
    dex1: await dex1.getAddress(),
    dex2: await dex2.getAddress(),
    nft1: await nft1.getAddress(),
    nft2: await nft2.getAddress(),
    arbitrageur: await arbitrageur.getAddress(),
  };
  writeFileSync(resolve(process.cwd(), "../frontend/src/deployments.local.json"), JSON.stringify(deployment, null, 2));
  console.log(JSON.stringify(deployment, null, 2));
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
