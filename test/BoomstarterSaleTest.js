'use strict';

import expectThrow from './helpers/expectThrow';
import {assertBigNumberEqual} from './helpers/asserts';
import {withRollback} from './helpers/EVMSnapshots';

const BoomstarterTokenTestHelper = artifacts.require('BoomstarterTokenTestHelper.sol');
const BoomstarterICOTestHelper = artifacts.require('BoomstarterICOTestHelper.sol');
const BoomstarterSaleTestHelper = artifacts.require('BoomstarterSaleTestHelper.sol');
const FundsRegistry = artifacts.require('FundsRegistry.sol');
const ReenterableMinter = artifacts.require('ReenterableMinter.sol');

var boomstarterTokenTestHelper;

var owners;
var beneficiary;
var buyers;
var sale;
var ico;
var fundsRegistry;
var oldMinter;
var minter;

const BN = (n) => new web3.BigNumber(n);

const totalSupply = 36e24; //36m tokens
const production = false;
var icoTokensSold = BN(0);
var icoOnlyTokensSold;

var icoTime = 1538341198;   // SEP 30, no bonuses

contract('BoomstarterSale', async function(accounts) {
  
    it("init ico", async function() {
        owners = [ accounts[0], accounts[1], accounts[2] ];
        buyers = [ accounts[4], accounts[5], accounts[6] ];
        beneficiary = accounts[3];

        // create Token
        boomstarterTokenTestHelper = await BoomstarterTokenTestHelper.new(owners, 2, {from: owners[0]});

        // create ICO
        ico = await BoomstarterICOTestHelper.new(owners, boomstarterTokenTestHelper.address, production);
        await boomstarterTokenTestHelper.transfer(ico.address, totalSupply, {from: owners[0]});
        await boomstarterTokenTestHelper.switchToNextSale(ico.address, {from: owners[0]});
        await ico.setTime(icoTime);

        // set eth price to $300
        await ico.setETHPriceManually(30000, {from: owners[0]});
        await ico.setETHPriceManually(30000, {from: owners[1]});
        await ico.topUp({value: web3.toWei(200, "finney")});

        // create Funds Registry
        fundsRegistry = await FundsRegistry.new(owners, 2, ico.address, boomstarterTokenTestHelper.address);
        await boomstarterTokenTestHelper.setSale(fundsRegistry.address, true, {from: owners[0]});
        await boomstarterTokenTestHelper.setSale(fundsRegistry.address, true, {from: owners[1]});
        await ico.init(fundsRegistry.address, beneficiary, 100000, {from: owners[0]});
        await ico.init(fundsRegistry.address, beneficiary, 100000, {from: owners[1]});

        assert.equal(await ico.m_tokenDistributor(), beneficiary);

        // create Minter
        oldMinter = await ReenterableMinter.new(ico.address, {from: owners[0]});
        await ico.setNonEtherController(oldMinter.address, {from: owners[0]});
        await ico.setNonEtherController(oldMinter.address, {from: owners[1]});
    });

    it("buy some tokens during ico", async function() {
        assertBigNumberEqual(await boomstarterTokenTestHelper.balanceOf(buyers[0]), 0);
        assertBigNumberEqual(await web3.eth.getBalance(fundsRegistry.address), web3.toWei(0, "ether"));

        await ico.buy({from: buyers[0], value: web3.toWei(1, "ether")});

        const tokens = BN(web3.toWei(1, "ether")).mul(300).div(2);
        icoTokensSold = icoTokensSold.add(tokens);
        assertBigNumberEqual(await boomstarterTokenTestHelper.balanceOf(buyers[0]), tokens);

        // check amount of ether collected
        assertBigNumberEqual(await web3.eth.getBalance(fundsRegistry.address), web3.toWei(1, "ether"));
        assertBigNumberEqual(await web3.eth.getBalance(ico.address), web3.toWei(200, "finney"));
    });

    it("buy with bitcoin during ico", async function() {
        assertBigNumberEqual(await boomstarterTokenTestHelper.balanceOf(buyers[1]), 0);

        await oldMinter.mint(1, buyers[1], web3.toWei(2, "ether"), {from: owners[0]});

        const tokens = BN(web3.toWei(2, "ether")).mul(300).div(2);
        icoTokensSold = icoTokensSold.add(tokens);
        assertBigNumberEqual(await boomstarterTokenTestHelper.balanceOf(buyers[1]), tokens);

        // check amount of ether collected
        assertBigNumberEqual(await web3.eth.getBalance(fundsRegistry.address), web3.toWei(1, "ether"),
                "balance must stay unchanged (bitcoin payment)");
        assertBigNumberEqual(await web3.eth.getBalance(ico.address), web3.toWei(200, "finney"));

        icoOnlyTokensSold = icoTokensSold;
    });

    it("migrate to sale", async function() {
        // 1
        sale = await BoomstarterSaleTestHelper.new(owners, boomstarterTokenTestHelper.address, production);
        await sale.setTime(icoTime);
        // 2
        await sale.setETHPriceManually(30000, {from: owners[0]});
        await sale.setETHPriceManually(30000, {from: owners[1]});
        await sale.topUp({value: web3.toWei(200, "finney")});
        // 3
        await boomstarterTokenTestHelper.setSale(sale.address, true, {from: owners[0]});
        await boomstarterTokenTestHelper.setSale(sale.address, true, {from: owners[1]});

        // 4
        minter = await ReenterableMinter.new(sale.address, {from: owners[0]});
        // 5
        await minter.transferOwnership(owners[2], {from: owners[0]});
        // 6
        assertBigNumberEqual(await sale.m_state(), 0);  // INIT
        await sale.setNonEtherController(minter.address, {from: owners[0]});
        await sale.setNonEtherController(minter.address, {from: owners[1]});

        // 7
        // -
        // 8
        await ico.pause({from: owners[0]});

        // 9
        await fundsRegistry.setController(sale.address, {from: owners[0]});
        await fundsRegistry.setController(sale.address, {from: owners[1]});
        // 10
        await ico.applyHotFix(sale.address, {from: owners[0]});
        await ico.applyHotFix(sale.address, {from: owners[1]});
        // 11
        await sale.init(fundsRegistry.address, beneficiary, {from: owners[0]});
        await sale.init(fundsRegistry.address, beneficiary, {from: owners[1]});

        // checking balance transfer
        assertBigNumberEqual(await web3.eth.getBalance(ico.address), web3.toWei(0, "finney"));
        assertBigNumberEqual(await boomstarterTokenTestHelper.balanceOf(ico.address), 0);

        assertBigNumberEqual(await web3.eth.getBalance(sale.address), web3.toWei(400, "finney"));
        assertBigNumberEqual(await boomstarterTokenTestHelper.balanceOf(sale.address),
                BN(totalSupply).sub(icoTokensSold));

        // checking links
        assert.equal(await fundsRegistry.m_controller(), sale.address);
        assert.equal(await sale.m_tokenDistributor(), beneficiary);
        assert.equal(await sale.m_funds(), fundsRegistry.address);
        assert.equal(await sale.m_token(), boomstarterTokenTestHelper.address);

        // checking states
        assertBigNumberEqual(await sale.m_state(), 1);  // ACTIVE
        assertBigNumberEqual(await fundsRegistry.m_state(), 0);     // GATHERING

        // checking other fields
        assertBigNumberEqual(await sale.m_currentTokensSold(), 0);
        assertBigNumberEqual(await sale.c_maximumTokensSold(), BN(totalSupply).mul(75).div(100).sub(icoOnlyTokensSold));
    });

    async function checkNotSendingEther() {
        await withRollback(async () => {
            await fundsRegistry.sendEther(owners[2], web3.toWei(0.1, 'ether'), {from: owners[0]});
            await expectThrow(fundsRegistry.sendEther(owners[2], web3.toWei(0.1, 'ether'), {from: owners[1]}));
        });
    }

    async function checkNotWithdrawing() {
        await withRollback(async () => {
            const balance = (await boomstarterTokenTestHelper.balanceOf(buyers[2])).toString();
            await boomstarterTokenTestHelper.approve(fundsRegistry.address,
                    balance, {from: buyers[2]});
            await expectThrow(fundsRegistry.withdrawPayments({from: buyers[2]}));
        });
    }

    it("buying during sale pre-stage", async function() {
        const initialBalance = await web3.eth.getBalance(fundsRegistry.address);
        assertBigNumberEqual(await boomstarterTokenTestHelper.balanceOf(buyers[2]), 0);

        await sale.setETHPriceManually(40000, {from: owners[0]});
        await sale.setETHPriceManually(40000, {from: owners[1]});

        await sale.buy({from: buyers[2], value: web3.toWei(0.5, "ether")});

        const tokens = BN(web3.toWei(100, "ether"));    // $2/token
        icoTokensSold = icoTokensSold.add(tokens);
        assertBigNumberEqual(await boomstarterTokenTestHelper.balanceOf(buyers[2]), tokens);

        // check amount of ether collected
        assertBigNumberEqual((await web3.eth.getBalance(fundsRegistry.address)).sub(initialBalance),
                web3.toWei(0.5, "ether"));

        await checkNotSendingEther();
        await checkNotWithdrawing();
    });

    it("buy with bitcoin during sale pre-stage", async function() {
        const initialBalance = await web3.eth.getBalance(fundsRegistry.address);
        const initialTokenBalance = await boomstarterTokenTestHelper.balanceOf(buyers[1]);

        // checking for illegal access
        for (const from_ of accounts)
            await expectThrow(sale.mint(buyers[1], web3.toWei(4, "ether"), {from: from_}));

        for (const from_ of [owners[0], owners[1], buyers[0], buyers[1], buyers[2]])
            await expectThrow(minter.mint(1, buyers[1], web3.toWei(4, "ether"), {from: from_}));

        await minter.mint(1, buyers[1], web3.toWei(4, "ether"), {from: owners[2]});

        const tokens = BN(web3.toWei(800, "ether"));
        icoTokensSold = icoTokensSold.add(tokens);
        assertBigNumberEqual(BN(await boomstarterTokenTestHelper.balanceOf(buyers[1])).sub(initialTokenBalance), tokens);

        // check amount of ether collected
        assertBigNumberEqual(await web3.eth.getBalance(fundsRegistry.address), initialBalance,
                "balance must stay unchanged (bitcoin payment)");
        assertBigNumberEqual(await web3.eth.getBalance(sale.address), web3.toWei(400, "finney"));

        // repeated minting with the same id
        await minter.mint(1, buyers[1], web3.toWei(4, "ether"), {from: owners[2]});
        await minter.mint(1, buyers[1], web3.toWei(2, "ether"), {from: owners[2]});
        assertBigNumberEqual(BN(await boomstarterTokenTestHelper.balanceOf(buyers[1])).sub(initialTokenBalance), tokens);
        assertBigNumberEqual(await web3.eth.getBalance(fundsRegistry.address), initialBalance);

        await checkNotSendingEther();
        await checkNotWithdrawing();
    });

    it("buying during sale with bonus", async function() {
        const initialBalance = await web3.eth.getBalance(fundsRegistry.address);
        const initialTokenBalance = await boomstarterTokenTestHelper.balanceOf(buyers[0]);

        await sale.setTime(1538946000);
        await sale.buy({from: buyers[0], value: web3.toWei(1, "ether")});

        const tokens = BN(web3.toWei(230, "ether"));    // $2/token + 15%
        icoTokensSold = icoTokensSold.add(tokens);
        assertBigNumberEqual(BN(await boomstarterTokenTestHelper.balanceOf(buyers[0])).sub(initialTokenBalance), tokens);
        assertBigNumberEqual((await web3.eth.getBalance(fundsRegistry.address)).sub(initialBalance),
                web3.toWei(1, "ether"));

        // in the middle of the period
        await sale.setTime(1539133506);
        await sale.buy({from: buyers[0], value: web3.toWei(1, "ether")});
        icoTokensSold = icoTokensSold.add(tokens);
        assertBigNumberEqual(BN(await boomstarterTokenTestHelper.balanceOf(buyers[0])).sub(initialTokenBalance),
                BN(tokens).mul(2));
        assertBigNumberEqual((await web3.eth.getBalance(fundsRegistry.address)).sub(initialBalance),
                BN(web3.toWei(1, "ether")).mul(2));

        // in the end of the period
        await sale.setTime(1539550799);
        await sale.buy({from: buyers[0], value: web3.toWei(1, "ether")});
        icoTokensSold = icoTokensSold.add(tokens);
        assertBigNumberEqual(BN(await boomstarterTokenTestHelper.balanceOf(buyers[0])).sub(initialTokenBalance),
                BN(tokens).mul(3));
        assertBigNumberEqual((await web3.eth.getBalance(fundsRegistry.address)).sub(initialBalance),
                BN(web3.toWei(1, "ether")).mul(3));

        await checkNotSendingEther();
        await checkNotWithdrawing();
    });

    it("buying during sale without bonuses", async function() {
        await withRollback(async () => {
            const initialBalance = await web3.eth.getBalance(fundsRegistry.address);
            const initialTokenBalance = await boomstarterTokenTestHelper.balanceOf(buyers[1]);

            await sale.setTime(1541019600);
            await sale.buy({from: buyers[1], value: web3.toWei(1, "ether")});

            const tokens = BN(web3.toWei(200, "ether"));    // $2/token
            assertBigNumberEqual(BN(await boomstarterTokenTestHelper.balanceOf(buyers[1])).sub(initialTokenBalance), tokens);
            assertBigNumberEqual((await web3.eth.getBalance(fundsRegistry.address)).sub(initialBalance),
                    web3.toWei(1, "ether"));

            await sale.setTime(1730408400);
            await sale.buy({from: buyers[1], value: web3.toWei(1, "ether")});
            assertBigNumberEqual(BN(await boomstarterTokenTestHelper.balanceOf(buyers[1])).sub(initialTokenBalance),
                    BN(tokens).mul(2));
            assertBigNumberEqual((await web3.eth.getBalance(fundsRegistry.address)).sub(initialBalance),
                    BN(web3.toWei(1, "ether")).mul(2));
        });

        await checkNotSendingEther();
        await checkNotWithdrawing();
    });

    async function checkFinished() {
        assertBigNumberEqual(await sale.m_state(), 4);  // SUCCEEDED
        assertBigNumberEqual(await fundsRegistry.m_state(), 2);  // SUCCEEDED

        assertBigNumberEqual(await boomstarterTokenTestHelper.balanceOf(sale.address), 0);
        assertBigNumberEqual(await boomstarterTokenTestHelper.balanceOf(beneficiary), BN(totalSupply).sub(icoTokensSold));

        // checking illegal access
        for (const from_ of buyers)
            await expectThrow(fundsRegistry.sendEther(from_, web3.toWei(4.5, 'ether'), {from: from_, gasPrice: 0}));
    }

    it("finishing with a call", async function() {
        for (const from_ of buyers)
            await expectThrow(sale.finishICO({from: from_}));

        await withRollback(async () => {
            await sale.finishICO({from: owners[0]});
            await sale.finishICO({from: owners[1]});

            await checkFinished();

            assertBigNumberEqual(await web3.eth.getBalance(fundsRegistry.address), web3.toWei(4.5, 'ether'));

            const initialBalance = await web3.eth.getBalance(owners[2]);

            await fundsRegistry.sendEther(owners[2], web3.toWei(4.5, 'ether'), {from: owners[0]});
            assertBigNumberEqual(await web3.eth.getBalance(owners[2]), initialBalance);
            await fundsRegistry.sendEther(owners[2], web3.toWei(4.5, 'ether'), {from: owners[1]});
            assertBigNumberEqual(await web3.eth.getBalance(owners[2]), BN(initialBalance).add(web3.toWei(4.5, 'ether')));

            await checkNotWithdrawing();
        });
    });

    it("finishing by hard cap", async function() {
        await withRollback(async () => {
            await sale.setTime(1541019600);

            await sale.setETHPriceManually(5000000000, {from: owners[0]});  // 1ETH = $50M
            await sale.setETHPriceManually(5000000000, {from: owners[1]});

            let initialBalance = await web3.eth.getBalance(fundsRegistry.address);
            const initialBuyerBalance = await web3.eth.getBalance(buyers[1]);
            const initialTokenBalance = await boomstarterTokenTestHelper.balanceOf(buyers[1]);

            await sale.buy({from: buyers[1], value: web3.toWei(2, "ether"), gasPrice: 0});

            const tokensBought = BN(totalSupply).mul(75).div(100).sub(icoTokensSold);
            icoTokensSold = icoTokensSold.add(tokensBought);
            const etherSpent = tokensBought.mul(200).div(5000000000);

            assertBigNumberEqual(BN(await sale.c_maximumTokensSold()).add(icoOnlyTokensSold), icoTokensSold);

            await checkFinished();
            icoTokensSold = icoTokensSold.sub(tokensBought);    // revert

            // checking balances and tokens
            assertBigNumberEqual(BN(await web3.eth.getBalance(fundsRegistry.address)).sub(initialBalance),
                    etherSpent);
            assertBigNumberEqual(BN(initialBuyerBalance).sub(await web3.eth.getBalance(buyers[1])), etherSpent);
            assertBigNumberEqual(BN(await boomstarterTokenTestHelper.balanceOf(buyers[1])).sub(initialTokenBalance),
                    tokensBought);

            // can send collected ether
            initialBalance = await web3.eth.getBalance(owners[2]);
            await fundsRegistry.sendEther(owners[2], web3.toWei(4.5, 'ether'), {from: owners[0]});
            await fundsRegistry.sendEther(owners[2], web3.toWei(4.5, 'ether'), {from: owners[1]});
            assertBigNumberEqual(await web3.eth.getBalance(owners[2]), BN(initialBalance).add(web3.toWei(4.5, 'ether')));

            await checkNotWithdrawing();
        });
    });

    it("finishing by timeout", async function() {
        await withRollback(async () => {
            await sale.setTime(1893445200);

            let initialBalance = await web3.eth.getBalance(fundsRegistry.address);
            const initialBuyerBalance = await web3.eth.getBalance(buyers[1]);
            const initialTokenBalance = await boomstarterTokenTestHelper.balanceOf(buyers[1]);

            await sale.buy({from: buyers[1], value: web3.toWei(1, "ether"), gasPrice: 0});

            await checkFinished();

            // checking balances and tokens
            assertBigNumberEqual(BN(await web3.eth.getBalance(fundsRegistry.address)).sub(initialBalance), 0);
            assertBigNumberEqual(BN(initialBuyerBalance).sub(await web3.eth.getBalance(buyers[1])), 0);
            assertBigNumberEqual(BN(await boomstarterTokenTestHelper.balanceOf(buyers[1])).sub(initialTokenBalance), 0);

            // can send collected ether
            initialBalance = await web3.eth.getBalance(owners[2]);
            await fundsRegistry.sendEther(owners[2], web3.toWei(4.5, 'ether'), {from: owners[0]});
            await fundsRegistry.sendEther(owners[2], web3.toWei(4.5, 'ether'), {from: owners[1]});
            assertBigNumberEqual(await web3.eth.getBalance(owners[2]), BN(initialBalance).add(web3.toWei(4.5, 'ether')));

            await checkNotWithdrawing();
        });
    });

    it("applying hotfix", async function() {
        await withRollback(async () => {
            const sale2 = await BoomstarterSaleTestHelper.new(owners, boomstarterTokenTestHelper.address, production);
            assert.notEqual(sale2, sale);

            await sale.pause({from: owners[0]});
            await sale.applyHotFix(sale2.address, {from: owners[0]});
            await sale.applyHotFix(sale2.address, {from: owners[1]});

            assertBigNumberEqual(await web3.eth.getBalance(sale2.address), web3.toWei(400, "finney"));
            assertBigNumberEqual(await boomstarterTokenTestHelper.balanceOf(sale2.address),
                    BN(totalSupply).sub(icoTokensSold));
        });
    });
});
