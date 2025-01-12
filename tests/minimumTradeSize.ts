import * as anchor from '@project-serum/anchor';
import { assert } from 'chai';
import { BN } from '../sdk';

import { Program, Wallet } from '@project-serum/anchor';

import { Keypair } from '@solana/web3.js';

import { Admin, ClearingHouse, PositionDirection } from '../sdk/src';

import {
	initializeQuoteAssetBank,
	mockOracle,
	mockUSDCMint,
	mockUserUSDCAccount,
} from './testHelpers';
import { calculateBaseAssetValue, FeeStructure, ZERO } from '../sdk';

describe('minimum trade size', () => {
	const provider = anchor.AnchorProvider.local(undefined, {
		commitment: 'confirmed',
		preflightCommitment: 'confirmed',
	});
	const connection = provider.connection;
	anchor.setProvider(provider);
	const chProgram = anchor.workspace.ClearingHouse as Program;

	let usdcMint;

	let primaryClearingHouse: Admin;

	// ammInvariant == k == x * y
	const ammInitialQuoteAssetReserve = new anchor.BN(17 * 10 ** 13);
	const ammInitialBaseAssetReserve = new anchor.BN(17 * 10 ** 13);
	const invariant = ammInitialQuoteAssetReserve.mul(ammInitialBaseAssetReserve);

	const usdcAmount = new BN(10000 * 10 ** 3);

	before(async () => {
		usdcMint = await mockUSDCMint(provider);

		primaryClearingHouse = Admin.from(
			connection,
			provider.wallet,
			chProgram.programId,
			{
				commitment: 'confirmed',
			},
			0,
			[new BN(0)],
			[new BN(0)]
		);
		await primaryClearingHouse.initialize(usdcMint.publicKey, true);
		await primaryClearingHouse.subscribe();

		await initializeQuoteAssetBank(primaryClearingHouse, usdcMint.publicKey);

		const solUsd = await mockOracle(63000);
		const periodicity = new BN(60 * 60); // 1 HOUR

		await primaryClearingHouse.initializeMarket(
			solUsd,
			ammInitialBaseAssetReserve,
			ammInitialQuoteAssetReserve,
			periodicity,
			new BN(63000000)
		);

		const newFeeStructure: FeeStructure = {
			feeNumerator: new BN(0),
			feeDenominator: new BN(1),
			discountTokenTiers: {
				firstTier: {
					minimumBalance: new BN(1),
					discountNumerator: new BN(1),
					discountDenominator: new BN(1),
				},
				secondTier: {
					minimumBalance: new BN(1),
					discountNumerator: new BN(1),
					discountDenominator: new BN(1),
				},
				thirdTier: {
					minimumBalance: new BN(1),
					discountNumerator: new BN(1),
					discountDenominator: new BN(1),
				},
				fourthTier: {
					minimumBalance: new BN(1),
					discountNumerator: new BN(1),
					discountDenominator: new BN(1),
				},
			},
			referralDiscount: {
				referrerRewardNumerator: new BN(1),
				referrerRewardDenominator: new BN(1),
				refereeDiscountNumerator: new BN(1),
				refereeDiscountDenominator: new BN(1),
			},
		};

		await primaryClearingHouse.updateFee(newFeeStructure);
	});

	beforeEach(async () => {
		await primaryClearingHouse.moveAmmPrice(
			ammInitialBaseAssetReserve,
			ammInitialQuoteAssetReserve,
			new BN(0)
		);
	});

	after(async () => {
		await primaryClearingHouse.unsubscribe();
	});

	it('short round', async () => {
		const keypair = new Keypair();
		await provider.connection.requestAirdrop(keypair.publicKey, 10 ** 9);
		const wallet = new Wallet(keypair);
		const userUSDCAccount = await mockUserUSDCAccount(
			usdcMint,
			usdcAmount,
			provider,
			keypair.publicKey
		);
		const clearingHouse = ClearingHouse.from(
			connection,
			wallet,
			chProgram.programId,
			{
				commitment: 'confirmed',
			},
			0,
			[new BN(0)],
			[new BN(0)]
		);
		await clearingHouse.subscribe();
		await clearingHouse.initializeUserAccountAndDepositCollateral(
			usdcAmount,
			userUSDCAccount.publicKey
		);

		await clearingHouse.fetchAccounts();
		const marketIndex = new BN(0);
		await clearingHouse.openPosition(
			PositionDirection.SHORT,
			usdcAmount,
			marketIndex,
			new BN(0)
		);

		assert(clearingHouse.getQuoteAssetTokenAmount().eq(usdcAmount));

		// make price slightly worse so we need to round trade amount
		const newBaseAssetReserve = ammInitialBaseAssetReserve
			.mul(new BN(9999999))
			.div(new BN(10000000));
		const newQuoteAssetReserve = invariant.div(newBaseAssetReserve);
		await primaryClearingHouse.moveAmmPrice(
			newBaseAssetReserve,
			newQuoteAssetReserve,
			new BN(0)
		);

		const market = primaryClearingHouse.getMarketAccount(0);
		let position = clearingHouse.getUserAccount().positions[0];
		const baseAssetValue = calculateBaseAssetValue(market, position);

		const expectedBaseAssetValue = new BN(10000189);
		assert(position.quoteAssetAmount.eq(usdcAmount));
		assert(baseAssetValue.eq(expectedBaseAssetValue));

		await clearingHouse.openPosition(
			PositionDirection.LONG,
			usdcAmount,
			marketIndex,
			new BN(0)
		);

		await clearingHouse.fetchAccounts();
		position = clearingHouse.getUserAccount().positions[0];

		assert(position.quoteAssetAmount.eq(ZERO));
		assert(position.baseAssetAmount.eq(ZERO));
		await clearingHouse.unsubscribe();
	});

	it('short dont round', async () => {
		const keypair = new Keypair();
		await provider.connection.requestAirdrop(keypair.publicKey, 10 ** 9);
		const wallet = new Wallet(keypair);
		const userUSDCAccount = await mockUserUSDCAccount(
			usdcMint,
			usdcAmount,
			provider,
			keypair.publicKey
		);
		const clearingHouse = ClearingHouse.from(
			connection,
			wallet,
			chProgram.programId,
			{
				commitment: 'confirmed',
			},
			0,
			[new BN(0)],
			[new BN(0)]
		);
		await clearingHouse.subscribe();
		await clearingHouse.initializeUserAccountAndDepositCollateral(
			usdcAmount,
			userUSDCAccount.publicKey
		);

		const marketIndex = new BN(0);
		await clearingHouse.openPosition(
			PositionDirection.SHORT,
			usdcAmount,
			marketIndex,
			new BN(0)
		);

		await clearingHouse.fetchAccounts();
		assert(clearingHouse.getQuoteAssetTokenAmount().eq(usdcAmount));

		// make price much worse
		const newBaseAssetReserve = ammInitialBaseAssetReserve
			.mul(new BN(1))
			.div(new BN(2));
		const newQuoteAssetReserve = invariant.div(newBaseAssetReserve);
		await primaryClearingHouse.moveAmmPrice(
			newBaseAssetReserve,
			newQuoteAssetReserve,
			new BN(0)
		);

		await clearingHouse.openPosition(
			PositionDirection.LONG,
			usdcAmount,
			marketIndex,
			new BN(0)
		);

		await clearingHouse.fetchAccounts();
		const position = clearingHouse.getUserAccount().positions[0];

		assert(position.quoteAssetAmount.gt(ZERO));
		assert(position.baseAssetAmount.lt(ZERO));
		await clearingHouse.unsubscribe();
	});

	it('long round', async () => {
		const keypair = new Keypair();
		await provider.connection.requestAirdrop(keypair.publicKey, 10 ** 9);
		const wallet = new Wallet(keypair);
		const userUSDCAccount = await mockUserUSDCAccount(
			usdcMint,
			usdcAmount,
			provider,
			keypair.publicKey
		);
		const clearingHouse = ClearingHouse.from(
			connection,
			wallet,
			chProgram.programId,
			{
				commitment: 'confirmed',
			},
			0,
			[new BN(0)],
			[new BN(0)]
		);
		await clearingHouse.subscribe();

		await clearingHouse.initializeUserAccountAndDepositCollateral(
			usdcAmount,
			userUSDCAccount.publicKey
		);

		const marketIndex = new BN(0);
		await clearingHouse.openPosition(
			PositionDirection.LONG,
			usdcAmount,
			marketIndex,
			new BN(0)
		);

		await clearingHouse.fetchAccounts();
		assert(clearingHouse.getQuoteAssetTokenAmount().eq(usdcAmount));

		// make price slightly worse so we need to round trade amount
		const newQuoteAssetReserve = ammInitialBaseAssetReserve
			.mul(new BN(9999999))
			.div(new BN(10000000));
		const newBaseAssetReserve = invariant.div(newQuoteAssetReserve);
		await primaryClearingHouse.moveAmmPrice(
			newBaseAssetReserve,
			newQuoteAssetReserve,
			new BN(0)
		);

		await clearingHouse.fetchAccounts();
		const market = primaryClearingHouse.getMarketAccount(0);
		let position = clearingHouse.getUserAccount().positions[0];
		const baseAssetValue = calculateBaseAssetValue(market, position);

		const expectedBaseAssetValue = new BN(9999811);
		assert(position.quoteAssetAmount.eq(usdcAmount));
		assert(baseAssetValue.eq(expectedBaseAssetValue));

		await clearingHouse.openPosition(
			PositionDirection.SHORT,
			usdcAmount,
			marketIndex,
			new BN(0)
		);

		await clearingHouse.fetchAccounts();
		position = clearingHouse.getUserAccount().positions[0];

		assert(position.quoteAssetAmount.eq(ZERO));
		assert(position.baseAssetAmount.eq(ZERO));
		await clearingHouse.unsubscribe();
	});

	it('short dont round', async () => {
		const keypair = new Keypair();
		await provider.connection.requestAirdrop(keypair.publicKey, 10 ** 9);
		const wallet = new Wallet(keypair);
		const userUSDCAccount = await mockUserUSDCAccount(
			usdcMint,
			usdcAmount,
			provider,
			keypair.publicKey
		);
		const clearingHouse = ClearingHouse.from(
			connection,
			wallet,
			chProgram.programId,
			{
				commitment: 'confirmed',
			},
			0,
			[new BN(0)],
			[new BN(0)]
		);
		await clearingHouse.subscribe();

		await clearingHouse.initializeUserAccountAndDepositCollateral(
			usdcAmount,
			userUSDCAccount.publicKey
		);

		const marketIndex = new BN(0);
		await clearingHouse.openPosition(
			PositionDirection.LONG,
			usdcAmount,
			marketIndex,
			new BN(0)
		);

		assert(clearingHouse.getQuoteAssetTokenAmount().eq(usdcAmount));

		// make price better so we dont need to round trade amount
		const newQuoteAssetReserve = ammInitialBaseAssetReserve
			.mul(new BN(4))
			.div(new BN(3));
		const newBaseAssetReserve = invariant.div(newQuoteAssetReserve);
		await primaryClearingHouse.moveAmmPrice(
			newBaseAssetReserve,
			newQuoteAssetReserve,
			new BN(0)
		);

		await clearingHouse.openPosition(
			PositionDirection.SHORT,
			usdcAmount,
			marketIndex,
			new BN(0)
		);

		await clearingHouse.fetchAccounts();
		const position = clearingHouse.getUserAccount().positions[0];
		assert(position.quoteAssetAmount.gt(ZERO));
		assert(position.baseAssetAmount.gt(ZERO));
		await clearingHouse.unsubscribe();
	});
});
