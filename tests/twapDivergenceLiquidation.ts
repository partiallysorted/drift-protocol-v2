import * as anchor from '@project-serum/anchor';
import { assert } from 'chai';
import { BN } from '../sdk';

import { Program } from '@project-serum/anchor';

import { PublicKey } from '@solana/web3.js';

import { Admin, MARK_PRICE_PRECISION, PositionDirection } from '../sdk/src';

import {
	mockOracle,
	mockUSDCMint,
	mockUserUSDCAccount,
	setFeedPrice,
	setFeedTwap,
	initializeQuoteAssetBank,
} from './testHelpers';

describe('twap divergence liquidation', () => {
	const provider = anchor.AnchorProvider.local(undefined, {
		preflightCommitment: 'confirmed',
		commitment: 'confirmed',
	});
	const connection = provider.connection;
	anchor.setProvider(provider);
	const chProgram = anchor.workspace.ClearingHouse as Program;

	let clearingHouse: Admin;

	let userAccountPublicKey: PublicKey;

	let usdcMint;
	let userUSDCAccount;

	// ammInvariant == k == x * y
	const mantissaSqrtScale = new BN(Math.sqrt(MARK_PRICE_PRECISION.toNumber()));
	const ammInitialQuoteAssetReserve = new anchor.BN(5 * 10 ** 13).mul(
		mantissaSqrtScale
	);
	const ammInitialBaseAssetReserve = new anchor.BN(5 * 10 ** 13).mul(
		mantissaSqrtScale
	);

	const usdcAmount = new BN(10 * 10 ** 6);

	const maxPositions = 5;

	before(async () => {
		usdcMint = await mockUSDCMint(provider);
		userUSDCAccount = await mockUserUSDCAccount(usdcMint, usdcAmount, provider);

		clearingHouse = Admin.from(
			connection,
			provider.wallet,
			chProgram.programId,
			{
				commitment: 'confirmed',
			},
			0,
			[new BN(0), new BN(1), new BN(2), new BN(3), new BN(4)],
			[new BN(0)]
		);
		await clearingHouse.initialize(usdcMint.publicKey, true);
		await clearingHouse.subscribe();

		await initializeQuoteAssetBank(clearingHouse, usdcMint.publicKey);

		for (let i = 0; i < maxPositions; i++) {
			// make invalid
			const oracle = await mockOracle(1, -7, 2147483647);
			const periodicity = new BN(0);

			await clearingHouse.initializeMarket(
				oracle,
				ammInitialBaseAssetReserve,
				ammInitialQuoteAssetReserve,
				periodicity
			);
		}

		[, userAccountPublicKey] =
			await clearingHouse.initializeUserAccountAndDepositCollateral(
				usdcAmount,
				userUSDCAccount.publicKey
			);

		const usdcPerPosition = usdcAmount
			.mul(new BN(5))
			.div(new BN(maxPositions))
			.mul(new BN(99))
			.div(new BN(100));
		for (let i = 0; i < maxPositions; i++) {
			await clearingHouse.fetchAccounts();
			await clearingHouse.openPosition(
				PositionDirection.LONG,
				usdcPerPosition,
				new BN(i),
				new BN(0)
			);
		}
	});

	after(async () => {
		await clearingHouse.unsubscribe();
	});

	it('liquidate', async () => {
		for (let i = 0; i < maxPositions; i++) {
			const oracle = clearingHouse.getMarketAccount(i).amm.oracle;
			await setFeedPrice(anchor.workspace.Pyth, 0.5, oracle);
			await setFeedTwap(anchor.workspace.Pyth, 100, oracle);
			await clearingHouse.updateFundingRate(oracle, new BN(i));
			await clearingHouse.moveAmmPrice(
				ammInitialBaseAssetReserve.mul(new BN(201)),
				ammInitialQuoteAssetReserve.mul(new BN(100)),
				new BN(i)
			);
		}

		try {
			const txSig = await clearingHouse.liquidate(userAccountPublicKey);
			const logs = (
				await connection.getTransaction(txSig, { commitment: 'confirmed' })
			).meta.logMessages;
			console.log('tx logs', logs);
		} catch (e) {
			console.log(e);
			assert(e.message.includes('0x17a6'));
			return;
		}
		assert(false);
	});
});
