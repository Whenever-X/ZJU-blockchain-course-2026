# ZJU-blockchain-course-2026


**以下内容为作业仓库的README.md中需要描述的内容。请根据自己的需要进行修改并提交。**

作业提交方式为：**提交视频文件**和**仓库的链接**到指定邮箱。⚠️ 不要发送源代码到邮箱，只需要提供**公开可见**的仓库链接（记得不要匿名仓库）。

## 如何运行

1. 在本地启动 Hardhat 节点：
    ```bash
    cd contracts
    npm ci
    npm run node
    ```

2. 在另一个终端的 `./contracts` 中安装需要的依赖，运行如下的命令：
    ```bash
    npm install
    ```
3. 在 `./contracts` 中编译并测试合约：
    ```bash
    npx hardhat compile
    npm test
    ```
4. 部署两个 DEX 和套利合约，并运行 20 个模拟用户：
    ```bash
    npm run deploy
    npm run simulate
    ```
5. 在 `./frontend` 中安装需要的依赖，运行如下的命令：
    ```bash
    npm install
    ```
6. 在 `./frontend` 中启动前端程序，运行如下的命令：
    ```bash
    npm run start
    ```

## 功能实现分析

本项目实现了一个运行在本地以太坊测试链上的 AMM DEX DApp，完成的功能如下。

1. **ERC20 测试代币**
   - `MockERC20.sol` 基于 OpenZeppelin ERC20 实现 Token A 和 Token B。
   - 部署时给部署账户铸造初始供应量，并提供 `faucet(to, amount)` 函数供测试账户领取代币。
   - 前端的“领取 Token A”和“领取 Token B”按钮会调用水龙头函数，并在交易确认后刷新余额。

2. **AMM 交易池**
   - `MiniDEX.sol` 使用 `Pool` 结构记录交易对地址、两种代币储备量、总流动性和创建时间。
   - `createPool` 对代币地址排序以统一储备顺序，同时允许对相同代币对重复创建多个独立池；每次创建获得新的池 ID。
   - `getPoolsByPair` 返回同一币对的所有池 ID；`poolByPair` 保留第一个池的 ID，兼容原查询接口。
   - 创建池子时选择交易所和 Token A / Token B，无需填写合约地址。创建后自动选中新池，再存入流动性；首次存入比例决定初始价格。
   - 兑换和添加流动性均使用“DEX + 池 ID”选择器，不同池的储备、NFT 仓位和价格分别展示。

3. **恒定乘积兑换和手续费**
   - 兑换遵循恒定乘积模型：`reserveA * reserveB = k`。
   - `quoteAmountOut` 根据输入储备、输出储备和输入数量计算输出数量。
   - 每笔交易收取 0.30% 手续费，手续费留在池子储备中，因此会按流动性份额由 LP 共同获得。
   - `swap` 支持 Token A 到 Token B 和 Token B 到 Token A 两个方向，并提供最小输出数量参数用于滑点保护。

4. **添加和移除流动性**
   - 用户通过 `addLiquidity` 存入两种 ERC20 代币。
   - 首次添加流动性使用两种存入数量的平方根计算流动性份额；后续添加按当前储备比例计算份额。
   - `removeLiquidity` 按用户流动性份额计算应返还的两种代币数量，并将资产转回用户。

5. **ERC721 流动性仓位凭证**
   - `LiquidityPositionNFT.sol` 为每次添加流动性铸造一个 ERC721 NFT。
   - DEX 使用 `positions` 映射记录 NFT 对应的池子、流动性份额、存入数量和创建时间，并在 NFT `tokenURI` 中写入池 ID、代币地址、存入数量和创建时间。
   - 只有 NFT 持有人可以移除对应流动性；移除时 NFT 被销毁，用户取回资产和累计手续费收益。
   - 前端列出每个池子的 LP 来源、持有人、两种存入数量、流动性份额和创建时间，并只向 NFT 持有人显示“销毁并取回”操作。

6. **20 个模拟用户**
   - `simulateUsers.ts` 使用本地节点提供的 20 个账户。
   - 每个账户先领取两种代币，再随机选择交易所、池子、兑换方向和数量；第一轮添加流动性，后续按随机条件撤销自己本轮模拟中创建的仓位。
   - 默认运行 3 轮、共 60 次随机兑换，输出各池交易次数和模拟前后的储备、价格。PowerShell 可通过 `$env:SIMULATION_ROUNDS="5"`（此处的5可替换为任意指定的轮次数） 调整轮数后再次运行 `npm run simulate`。

7. **Bonus 1：两个不同价格的 DEX**
   - `deploy.ts` 部署两个独立的 `MiniDEX` 实例，并分别部署对应的流动性 NFT 合约。
   - 每个 DEX 初始化两个 A/B 池。DEX 1 的 A:B 储备为 `100000:100000`、`60000:90000`；DEX 2 为 `200000:100000`、`100000:80000`。
   - 四个池的初始 B/A 价格分别为 `1`、`1.5`、`0.5`、`0.8`，在上一部分提及的随机用户交易继续改变这些价格。
   - 部署脚本会把所有合约地址写入 `frontend/src/deployments.local.json`，供前端使用。

8. **Bonus 2：原子套利**
   - `Arbitrageur.sol` 先在低价池兑换，再在高价池反向兑换。
   - 两次兑换由同一个套利合约调用，在一笔链上交易中完成。
   - 合约检查最终资产是否不少于本金加最低利润；如果套利不盈利，交易会 `revert`，前面已经执行的兑换也会一起回滚。
   - 前端每 5 秒读取同一区块的池状态，扫描所有相同币对的有流动性池，比较包含两次手续费和价格冲击的回收量，按利润排序。支持同一 DEX 的不同池，以及跨 DEX 池；支持 Token A 或 Token B 作为本金，新增的池也会自动纳入。
   - “准备代币授权”是独立准备步骤；“执行原子套利（一笔交易）”只发送一次 `Arbitrageur.execute` 调用。合约内部完成两次 `swap`、利润检查和资产返还；`staticCall` 预检查只读状态，不发送交易。
   - 预估不盈利或低于最低利润时禁止执行。执行前再次读取报价并模拟调用；链上检查仍是最终保障。中间输出采用 0.50% 滑点保护。
   - 结果展示单个交易哈希、区块、实际投入/中间兑换/回收数量、代币利润、钱包两种代币余额，以及两个池的价格和储备变化。代币利润与 ETH 网络费分别显示，避免将不同单位混算。
   - 套利合约校验两池币对、禁止选择同一个池，并只使用本次交易获得的代币，不消耗合约原有余额。

修改合约后需要重新执行 `npm run compile` 和 `npm run deploy`，再刷新前端并连接钱包。旧合约代码不会因修改源码而自动更新。项目固定使用 npm 安装的 `solc 0.8.20` 编译，避免依赖额外的编译器下载与 Windows 缓存锁。


## 项目运行截图

### 1. 启动本地链

在本地启动HardHat节点：在 `contracts` 目录执行 `npm run node`,节点开始运行并显示节点运行端口与二十个账户信息：

![alt text](images/image.png)

### 2. 编译，部署合约与账户随机行为模拟

在另一个终端执行合约部署与用户行为模拟操作，用户行为模拟会运行 3 轮、共 60 次随机兑换，各池交易次数和模拟前后的储备、价格如下图所示。：

```bash
npx hardhat compile
npm run deploy
npm run simulate
```
![alt text](images/image-1.png)
![alt text](images/image-2.png)


### 3. 启动前端并连接钱包

在 `frontend` 目录执行 `npm run start`，打开 `http://localhost:3000`，。

在 MetaMask 中：

1. 添加本地网络 `http://127.0.0.1:8545`；
2. Chain ID 设置为 `31337`；
3. 点击添加钱包：通过私钥导入 Hardhat提供的测试账户。账户私钥见[模拟账户](./resources/模拟账户.txt)或在终端上运行`npm run node`后查看；

在前端页面（`http://localhost:3000`），点击连接钱包连接当前测试用户

**网络配置**

![alt text](images/image-3.png)

**导入测试用户**
![alt text](images/image-4.png)

**连接钱包**
![alt text](images/image-6.png)


### 4. 领取测试代币

在前端页面中，依次点击“领取 Token A”和“领取 Token B”，在 MetaMask 中确认交易，此处以领取Token A为例，领取后Token A余额增加1000。

**领取代币位置如图所示：**
![alt text](images/image-5.png)

**领取代币前状态**
![alt text](images/image-7.png)

**领取代币后状态**
![alt text](images/image-8.png)

### 5. 查看交易池的价格差与创建新交易池

可以在前端查看目前两个交易所的所有交易池信息，包括兑换价格，代币库存，LP仓位与手续费。用户也可以通过选择交易所，代币对来创建新的交易池。

**查看交易池的信息**
![alt text](images/image-9.png)

**创建交易池**
![alt text](images/image-10.png)

**上一步中被创建新交易池，需要用户添加流动性**
![alt text](images/image-11.png)


### 6. 添加流动性并获得 NFT

在前端“添加流动性”区域输入相同数量的 Token A 和 Token B，例如各 `500`，点击“存入并铸造 NFT”，并在MetaMask上确认两次授权和一次添加流动性的交易。获得的NFT可以在NFT板块查看具体信息，包括NFT ID，持有人，初始存入，份额占比等关键信息。对于已经有流动性的池子，实际存入数量按当前储备比例计算。

**添加流动性前交易池状态**
![alt text](images/image-12.png)

**添加流动性**
![alt text](images/image-13.png)

**添加流动性后交易池状态，实际存入代币数量为500 Token A与约498 Token B，证明系统确实按照当前交易池内代币储备比例计算实际存入量**
![alt text](images/image-14.png)

**NFT 板块展示**
![alt text](images/image-16.png)

**当前用户持有的NFT凭证展示**
![alt text](images/image-17.png)


### 7. 执行兑换

在“兑换”区域选择具体交易所与池子，选择输入代币并选择代币数量，页面会显示预计获得的目标代币数量，点击“兑换”并确认交易。

![alt text](images/image-15.png)

### 8. 移除流动性

在“流动性 NFT”区域选择交易所并输入 NFT ID ，点击“销毁 NFT 并取回资产”。

**手动销毁仓位NFT**
![alt text](images/image-18.png)



### 9. 执行原子套利

- 在“原子套利监控”中选择本金代币、数量和最低利润。系统会展示当前所有套利路线并且可以自动选择最有路线。选定路线后，系统将显示预计中间兑换数量，预计回收本金代币，预计代币利润等信息。
- 先点击“① 准备代币授权”，确认授权；额度足够后点击“② 执行原子套利（一笔交易）”，在 MetaMask 中确认一笔套利交易。
-如果套利失败，整个交易会revert

**原子套利监控界面**
![alt text](images/image-19.png)

**套利路线界面**
![alt text](images/image-20.png)

**套利前后资产的价格、数量变化和盈利情况**
![alt text](images/image-21.png)

## 参考内容

- 课程的参考Demo见：[DEMOs](https://github.com/LBruyne/blockchain-course-demos)。

- 快速实现 ERC721 和 ERC20：[模版](https://wizard.openzeppelin.com/#erc20)。记得安装相关依赖，例如 ``"@openzeppelin/contracts": "^5.0.0"``。

- 如何实现ETH和ERC20的兑换？ [参考讲解](https://www.wtf.academy/en/docs/solidity-103/DEX/)

如果有其它参考的内容，也请在这里陈列。
