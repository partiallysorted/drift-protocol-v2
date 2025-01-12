import * as anchor from '@project-serum/anchor';
import { assert } from 'chai';

import { Program } from '@project-serum/anchor';

import { Keypair, PublicKey } from '@solana/web3.js';

import {
	Admin,
	BN,
	MARK_PRICE_PRECISION,
	ClearingHouse,
	PositionDirection,
	ClearingHouseUser,
	OrderStatus,
	OrderDiscountTier,
	OrderAction,
	OrderTriggerCondition,
	calculateTargetPriceTrade,
	convertToNumber,
	QUOTE_PRECISION,
	Wallet,
	calculateTradeSlippage,
	getLimitOrderParams,
	getTriggerMarketOrderParams,
	EventSubscriber,
} from '../sdk/src';

import { calculateAmountToTradeForLimit } from '../sdk/src/orders';

import {
	mockOracle,
	mockUserUSDCAccount,
	mockUSDCMint,
	setFeedPrice,
	initializeQuoteAssetBank,
} from './testHelpers';
import {
	AMM_RESERVE_PRECISION,
	calculateMarkPrice,
	findComputeUnitConsumption,
	getMarketOrderParams,
	isVariant,
	OracleSource,
	TEN_THOUSAND,
	TWO,
	ZERO,
} from '../sdk';
import { AccountInfo, Token, TOKEN_PROGRAM_ID } from '@solana/spl-token';

const enumsAreEqual = (
	actual: Record<string, unknown>,
	expected: Record<string, unknown>
): boolean => {
	return JSON.stringify(actual) === JSON.stringify(expected);
};

describe('orders', () => {
	const provider = anchor.AnchorProvider.local(undefined, {
		preflightCommitment: 'confirmed',
		commitment: 'confirmed',
	});
	const connection = provider.connection;
	anchor.setProvider(provider);
	const chProgram = anchor.workspace.ClearingHouse as Program;

	let clearingHouse: Admin;
	let clearingHouseUser: ClearingHouseUser;
	const eventSubscriber = new EventSubscriber(connection, chProgram);
	eventSubscriber.subscribe();

	let userAccountPublicKey: PublicKey;

	let whaleAccountPublicKey: PublicKey;

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

	const whaleKeyPair = new Keypair();
	const usdcAmountWhale = new BN(10000000 * 10 ** 6);
	let whaleUSDCAccount: Keypair;
	let whaleClearingHouse: ClearingHouse;
	let whaleUser: ClearingHouseUser;

	let discountMint: Token;
	let discountTokenAccount: AccountInfo;

	const fillerKeyPair = new Keypair();
	let fillerUSDCAccount: Keypair;
	let fillerClearingHouse: ClearingHouse;
	let fillerUser: ClearingHouseUser;

	const marketIndex = new BN(0);
	const marketIndexBTC = new BN(1);
	const marketIndexEth = new BN(2);

	let solUsd;
	let btcUsd;
	let ethUsd;

	before(async () => {
		usdcMint = await mockUSDCMint(provider);
		userUSDCAccount = await mockUserUSDCAccount(usdcMint, usdcAmount, provider);

		solUsd = await mockOracle(1);
		btcUsd = await mockOracle(60000);
		ethUsd = await mockOracle(1);

		const marketIndexes = [marketIndex, marketIndexBTC, marketIndexEth];
		const bankIndexes = [new BN(0)];
		const oracleInfos = [
			{ publicKey: solUsd, source: OracleSource.PYTH },
			{ publicKey: btcUsd, source: OracleSource.PYTH },
			{ publicKey: ethUsd, source: OracleSource.PYTH },
		];

		clearingHouse = Admin.from(
			connection,
			provider.wallet,
			chProgram.programId,
			{
				commitment: 'confirmed',
			},
			0,
			marketIndexes,
			bankIndexes,
			oracleInfos
		);
		await clearingHouse.initialize(usdcMint.publicKey, true);
		await clearingHouse.subscribe();
		await initializeQuoteAssetBank(clearingHouse, usdcMint.publicKey);

		const periodicity = new BN(60 * 60); // 1 HOUR

		await clearingHouse.initializeMarket(
			solUsd,
			ammInitialBaseAssetReserve,
			ammInitialQuoteAssetReserve,
			periodicity
		);

		await clearingHouse.initializeMarket(
			btcUsd,
			ammInitialBaseAssetReserve.div(new BN(3000)),
			ammInitialQuoteAssetReserve.div(new BN(3000)),
			periodicity,
			new BN(60000000) // btc-ish price level
		);

		await clearingHouse.initializeMarket(
			ethUsd,
			ammInitialBaseAssetReserve,
			ammInitialQuoteAssetReserve,
			periodicity
		);

		[, userAccountPublicKey] =
			await clearingHouse.initializeUserAccountAndDepositCollateral(
				usdcAmount,
				userUSDCAccount.publicKey
			);

		clearingHouseUser = ClearingHouseUser.from(
			clearingHouse,
			provider.wallet.publicKey
		);
		await clearingHouseUser.subscribe();

		discountMint = await Token.createMint(
			connection,
			// @ts-ignore
			provider.wallet.payer,
			provider.wallet.publicKey,
			provider.wallet.publicKey,
			6,
			TOKEN_PROGRAM_ID
		);

		await clearingHouse.updateDiscountMint(discountMint.publicKey);

		discountTokenAccount = await discountMint.getOrCreateAssociatedAccountInfo(
			provider.wallet.publicKey
		);

		await discountMint.mintTo(
			discountTokenAccount.address,
			// @ts-ignore
			provider.wallet.payer,
			[],
			1000 * 10 ** 6
		);

		provider.connection.requestAirdrop(fillerKeyPair.publicKey, 10 ** 9);
		fillerUSDCAccount = await mockUserUSDCAccount(
			usdcMint,
			usdcAmount,
			provider,
			fillerKeyPair.publicKey
		);
		fillerClearingHouse = ClearingHouse.from(
			connection,
			new Wallet(fillerKeyPair),
			chProgram.programId,
			{
				commitment: 'confirmed',
			},
			0,
			marketIndexes,
			bankIndexes,
			oracleInfos
		);
		await fillerClearingHouse.subscribe();

		await fillerClearingHouse.initializeUserAccountAndDepositCollateral(
			usdcAmount,
			fillerUSDCAccount.publicKey
		);

		fillerUser = ClearingHouseUser.from(
			fillerClearingHouse,
			fillerKeyPair.publicKey
		);
		await fillerUser.subscribe();

		provider.connection.requestAirdrop(whaleKeyPair.publicKey, 10 ** 9);
		whaleUSDCAccount = await mockUserUSDCAccount(
			usdcMint,
			usdcAmountWhale,
			provider,
			whaleKeyPair.publicKey
		);
		whaleClearingHouse = ClearingHouse.from(
			connection,
			new Wallet(whaleKeyPair),
			chProgram.programId,
			{
				commitment: 'confirmed',
			},
			0,
			marketIndexes,
			bankIndexes,
			oracleInfos
		);
		await whaleClearingHouse.subscribe();

		[, whaleAccountPublicKey] =
			await whaleClearingHouse.initializeUserAccountAndDepositCollateral(
				usdcAmountWhale,
				whaleUSDCAccount.publicKey
			);

		whaleUser = ClearingHouseUser.from(
			whaleClearingHouse,
			whaleKeyPair.publicKey
		);

		await whaleUser.subscribe();
	});

	after(async () => {
		await clearingHouse.unsubscribe();
		await clearingHouseUser.unsubscribe();
		await fillerClearingHouse.unsubscribe();
		await fillerUser.unsubscribe();

		await whaleClearingHouse.unsubscribe();
		await whaleUser.unsubscribe();

		await eventSubscriber.unsubscribe();
	});

	it('Open long limit order', async () => {
		// user has $10, no open positions, trading in market of $1 mark price coin
		const direction = PositionDirection.LONG;
		const baseAssetAmount = new BN(AMM_RESERVE_PRECISION);
		const price = MARK_PRICE_PRECISION.mul(new BN(2));
		const reduceOnly = true;
		const triggerPrice = new BN(0);

		const orderParams = getLimitOrderParams(
			marketIndex,
			direction,
			baseAssetAmount,
			price,
			reduceOnly,
			true
		);
		// user sets reduce-only taker limit buy @ $2
		const txSig = await clearingHouse.placeOrder(
			orderParams,
			discountTokenAccount.address
		);
		console.log(
			'tx logs',
			(await connection.getTransaction(txSig, { commitment: 'confirmed' })).meta
				.logMessages
		);

		await clearingHouse.fetchAccounts();
		await clearingHouseUser.fetchAccounts();
		const order = clearingHouseUser.getUserAccount().orders[0];
		const expectedOrderId = new BN(1);

		assert(order.baseAssetAmount.eq(baseAssetAmount));
		assert(order.price.eq(price));
		assert(order.triggerPrice.eq(triggerPrice));
		assert(order.marketIndex.eq(marketIndex));
		assert(order.reduceOnly === reduceOnly);
		assert(enumsAreEqual(order.direction, direction));
		assert(enumsAreEqual(order.status, OrderStatus.OPEN));
		assert(enumsAreEqual(order.discountTier, OrderDiscountTier.FOURTH));
		assert(order.orderId.eq(expectedOrderId));
		assert(order.ts.gt(ZERO));

		const position = clearingHouseUser.getUserAccount().positions[0];
		const expectedOpenOrders = new BN(1);
		assert(position.openOrders.eq(expectedOpenOrders));

		const orderRecord = eventSubscriber.getEventsArray('OrderRecord')[0];
		assert(orderRecord.ts.gt(ZERO));
		assert(orderRecord.order.orderId.eq(expectedOrderId));
		assert(enumsAreEqual(orderRecord.action, OrderAction.PLACE));
		assert(
			orderRecord.user.equals(await clearingHouseUser.getUserAccountPublicKey())
		);
		assert(orderRecord.authority.equals(clearingHouseUser.authority));
	});

	it('Fail to fill reduce only order', async () => {
		const order = clearingHouseUser.getUserAccount().orders[0];

		try {
			await fillerClearingHouse.fillOrder(
				userAccountPublicKey,
				clearingHouseUser.getUserAccount(),
				order
			);
		} catch (e) {
			return;
		}

		assert(false);
	});

	it('Cancel order', async () => {
		const orderIndex = new BN(0);
		const orderId = new BN(1);
		await clearingHouse.cancelOrder(orderId);

		await clearingHouse.fetchAccounts();
		await clearingHouseUser.fetchAccounts();
		const order =
			clearingHouseUser.getUserAccount().orders[orderIndex.toNumber()];

		assert(order.baseAssetAmount.eq(new BN(0)));
		assert(order.price.eq(new BN(0)));
		assert(order.marketIndex.eq(new BN(0)));
		assert(enumsAreEqual(order.direction, PositionDirection.LONG));
		assert(enumsAreEqual(order.status, OrderStatus.INIT));

		const position = clearingHouseUser.getUserAccount().positions[0];
		const expectedOpenOrders = new BN(0);
		assert(position.openOrders.eq(expectedOpenOrders));

		const orderRecord = eventSubscriber.getEventsArray('OrderRecord')[0];
		const expectedOrderId = new BN(1);
		assert(orderRecord.ts.gt(ZERO));
		assert(orderRecord.order.orderId.eq(expectedOrderId));
		assert(enumsAreEqual(orderRecord.action, OrderAction.CANCEL));
		assert(
			orderRecord.user.equals(await clearingHouseUser.getUserAccountPublicKey())
		);
		assert(orderRecord.authority.equals(clearingHouseUser.authority));
	});

	it('Fill limit long order', async () => {
		const direction = PositionDirection.LONG;
		const baseAssetAmount = new BN(AMM_RESERVE_PRECISION);
		const price = MARK_PRICE_PRECISION.mul(new BN(2));
		const market0 = clearingHouse.getMarketAccount(marketIndex);

		console.log('markPrice:', calculateMarkPrice(market0).toString());

		const orderParams = getLimitOrderParams(
			marketIndex,
			direction,
			baseAssetAmount,
			price,
			false,
			true
		);
		await clearingHouse.placeOrder(orderParams, discountTokenAccount.address);
		const orderIndex = new BN(0);
		const orderId = new BN(2);
		await clearingHouseUser.fetchAccounts();
		let order = clearingHouseUser.getOrder(orderId);
		await fillerClearingHouse.fillOrder(
			userAccountPublicKey,
			clearingHouseUser.getUserAccount(),
			order
		);

		await fillerClearingHouse.settlePNLs(
			[
				{
					settleeUserAccountPublicKey:
						await clearingHouse.getUserAccountPublicKey(),
					settleeUserAccount: clearingHouse.getUserAccount(),
				},
				{
					settleeUserAccountPublicKey:
						await fillerClearingHouse.getUserAccountPublicKey(),
					settleeUserAccount: fillerClearingHouse.getUserAccount(),
				},
			],
			marketIndex
		);

		await clearingHouse.fetchAccounts();
		await clearingHouseUser.fetchAccounts();
		await fillerUser.fetchAccounts();

		order = clearingHouseUser.getUserAccount().orders[orderIndex.toString()];

		const expectedFillerReward = new BN(95);
		console.log(
			'FillerReward: $',
			convertToNumber(
				fillerClearingHouse.getQuoteAssetTokenAmount().sub(usdcAmount),
				QUOTE_PRECISION
			)
		);
		assert(
			fillerClearingHouse
				.getQuoteAssetTokenAmount()
				.sub(usdcAmount)
				.eq(expectedFillerReward)
		);

		const market = clearingHouse.getMarketAccount(marketIndex);
		console.log('markPrice After:', calculateMarkPrice(market).toString());

		const expectedFeeToMarket = new BN(855);
		assert(market.amm.totalFee.eq(expectedFeeToMarket));

		const userAccount = clearingHouseUser.getUserAccount();
		const expectedTokenDiscount = new BN(50);
		assert(userAccount.totalTokenDiscount.eq(expectedTokenDiscount));

		assert(order.baseAssetAmount.eq(new BN(0)));
		assert(order.price.eq(new BN(0)));
		assert(order.marketIndex.eq(new BN(0)));
		assert(enumsAreEqual(order.direction, PositionDirection.LONG));
		assert(enumsAreEqual(order.status, OrderStatus.INIT));

		const firstPosition = clearingHouseUser.getUserAccount().positions[0];
		assert(firstPosition.baseAssetAmount.eq(baseAssetAmount));

		const expectedQuoteAssetAmount = new BN(1000003);
		// console.log(convertToNumber(firstPosition.quoteAssetAmount, QUOTE_PRECISION),
		//  '!=',
		//  convertToNumber(expectedQuoteAssetAmount, QUOTE_PRECISION),
		//  );
		assert(firstPosition.quoteAssetAmount.eq(expectedQuoteAssetAmount));

		const tradeHistoryRecord = eventSubscriber.getEventsArray('TradeRecord')[0];
		assert.ok(tradeHistoryRecord.baseAssetAmount.eq(baseAssetAmount));
		assert.ok(tradeHistoryRecord.quoteAssetAmount.eq(expectedQuoteAssetAmount));

		const orderRecord = eventSubscriber.getEventsArray('OrderRecord')[0];
		const expectedTradeRecordId = new BN(1);
		const expectedFee = new BN(950);
		assert(orderRecord.ts.gt(ZERO));
		assert(orderRecord.fee.eq(expectedFee));
		assert(orderRecord.order.fee.eq(expectedFee));
		assert(enumsAreEqual(orderRecord.action, OrderAction.FILL));
		assert(
			orderRecord.user.equals(await clearingHouseUser.getUserAccountPublicKey())
		);
		assert(orderRecord.authority.equals(clearingHouseUser.authority));
		assert(
			orderRecord.filler.equals(await fillerUser.getUserAccountPublicKey())
		);
		assert(orderRecord.baseAssetAmountFilled.eq(baseAssetAmount));
		assert(orderRecord.quoteAssetAmountFilled.eq(expectedQuoteAssetAmount));
		assert(orderRecord.fillerReward.eq(expectedFillerReward));
		console.log(orderRecord.tradeRecordId.toString());
		assert(orderRecord.tradeRecordId.eq(expectedTradeRecordId));
	});

	it('Fill stop short order', async () => {
		const direction = PositionDirection.SHORT;
		const baseAssetAmount = new BN(AMM_RESERVE_PRECISION);
		const triggerPrice = MARK_PRICE_PRECISION;
		const triggerCondition = OrderTriggerCondition.ABOVE;
		const market0 = clearingHouse.getMarketAccount(marketIndex);

		console.log('markPrice:', calculateMarkPrice(market0).toString());

		const orderParams = getTriggerMarketOrderParams(
			marketIndex,
			direction,
			baseAssetAmount,
			triggerPrice,
			triggerCondition,
			false,
			true
		);
		await clearingHouse.placeOrder(orderParams, discountTokenAccount.address);
		const orderId = new BN(3);
		const orderIndex = new BN(0);
		await clearingHouseUser.fetchAccounts();
		let order = clearingHouseUser.getOrder(orderId);
		const txSig = await fillerClearingHouse.fillOrder(
			userAccountPublicKey,
			clearingHouseUser.getUserAccount(),
			order
		);

		const computeUnits = await findComputeUnitConsumption(
			clearingHouse.program.programId,
			connection,
			txSig,
			'confirmed'
		);
		console.log('compute units', computeUnits);
		console.log(
			'tx logs',
			(await connection.getTransaction(txSig, { commitment: 'confirmed' })).meta
				.logMessages
		);

		await fillerClearingHouse.settlePNLs(
			[
				{
					settleeUserAccountPublicKey:
						await clearingHouse.getUserAccountPublicKey(),
					settleeUserAccount: clearingHouse.getUserAccount(),
				},
				{
					settleeUserAccountPublicKey:
						await fillerClearingHouse.getUserAccountPublicKey(),
					settleeUserAccount: fillerClearingHouse.getUserAccount(),
				},
			],
			marketIndex
		);

		await clearingHouse.fetchAccounts();
		await clearingHouseUser.fetchAccounts();
		await fillerUser.fetchAccounts();

		order = clearingHouseUser.getUserAccount().orders[orderIndex.toString()];

		const expectedFillerReward = new BN(190);
		console.log(
			'FillerReward: $',
			convertToNumber(
				fillerClearingHouse.getQuoteAssetTokenAmount().sub(usdcAmount),
				QUOTE_PRECISION
			)
		);
		assert(
			fillerClearingHouse
				.getQuoteAssetTokenAmount()
				.sub(usdcAmount)
				.eq(expectedFillerReward)
		);

		const market = clearingHouse.getMarketAccount(marketIndex);
		console.log('markPrice after:', calculateMarkPrice(market).toString());

		const expectedFeeToMarket = new BN(1710);
		assert(market.amm.totalFee.eq(expectedFeeToMarket));

		const userAccount = clearingHouseUser.getUserAccount();
		const expectedTokenDiscount = new BN(100);
		console.log(
			userAccount.totalTokenDiscount.toString(),
			'=',
			expectedTokenDiscount.toString()
		);

		assert(userAccount.totalTokenDiscount.eq(expectedTokenDiscount));

		assert(order.baseAssetAmount.eq(new BN(0)));
		assert(order.price.eq(new BN(0)));
		assert(order.marketIndex.eq(new BN(0)));
		assert(enumsAreEqual(order.direction, PositionDirection.LONG));
		assert(enumsAreEqual(order.status, OrderStatus.INIT));

		const firstPosition = clearingHouseUser.getUserAccount().positions[0];
		const expectedBaseAssetAmount = new BN(0);
		assert(firstPosition.baseAssetAmount.eq(expectedBaseAssetAmount));

		const expectedQuoteAssetAmount = new BN(0);
		assert(firstPosition.quoteAssetAmount.eq(expectedQuoteAssetAmount));

		const tradeHistoryRecord = eventSubscriber.getEventsArray('TradeRecord')[0];

		assert.ok(tradeHistoryRecord.baseAssetAmount.eq(baseAssetAmount));
		const expectedTradeQuoteAssetAmount = new BN(1000002);
		console.log(
			'expectedTradeQuoteAssetAmount check:',
			tradeHistoryRecord.quoteAssetAmount,
			'=',
			expectedTradeQuoteAssetAmount.toString()
		);
		assert.ok(
			tradeHistoryRecord.quoteAssetAmount.eq(expectedTradeQuoteAssetAmount)
		);
		assert.ok(tradeHistoryRecord.markPriceBefore.gt(triggerPrice));

		const orderRecord = eventSubscriber.getEventsArray('OrderRecord')[0];
		const expectedOrderId = new BN(3);
		const expectedTradeRecordId = new BN(2);
		assert(orderRecord.ts.gt(ZERO));
		assert(orderRecord.order.orderId.eq(expectedOrderId));
		assert(enumsAreEqual(orderRecord.action, OrderAction.FILL));
		assert(
			orderRecord.user.equals(await clearingHouseUser.getUserAccountPublicKey())
		);
		assert(orderRecord.authority.equals(clearingHouseUser.authority));
		assert(
			orderRecord.filler.equals(await fillerUser.getUserAccountPublicKey())
		);
		assert(orderRecord.baseAssetAmountFilled.eq(baseAssetAmount));
		assert(
			orderRecord.quoteAssetAmountFilled.eq(expectedTradeQuoteAssetAmount)
		);
		assert(orderRecord.tradeRecordId.eq(expectedTradeRecordId));
	});

	it('Fail to fill limit short order', async () => {
		const direction = PositionDirection.SHORT;
		const baseAssetAmount = new BN(AMM_RESERVE_PRECISION);
		const market = clearingHouse.getMarketAccount(marketIndex);
		const limitPrice = calculateMarkPrice(market); // 0 liquidity at current mark price
		const orderParams = getLimitOrderParams(
			marketIndex,
			direction,
			baseAssetAmount,
			limitPrice,
			false,
			true
		);
		await clearingHouse.placeOrder(orderParams, discountTokenAccount.address);

		await clearingHouse.fetchAccounts();
		const order = clearingHouseUser.getUserAccount().orders[0];
		const amountToFill = calculateAmountToTradeForLimit(market, order);

		assert(amountToFill.eq(ZERO));

		console.log(amountToFill);

		const orderId = new BN(4);
		try {
			await clearingHouseUser.fetchAccounts();
			const order = clearingHouseUser.getOrder(orderId);
			console.log(order);
			await fillerClearingHouse.fillOrder(
				userAccountPublicKey,
				clearingHouseUser.getUserAccount(),
				order
			);
			const order2 = clearingHouseUser.getOrder(orderId);
			console.log(order2);

			await clearingHouse.cancelOrder(orderId);
		} catch (e) {
			await clearingHouse.cancelOrder(orderId);
			return;
		}

		assert(false);
	});

	it('Partial fill limit short order', async () => {
		const direction = PositionDirection.SHORT;
		const baseAssetAmount = new BN(AMM_RESERVE_PRECISION);
		await clearingHouse.fetchAccounts();
		const market = clearingHouse.getMarketAccount(marketIndex);
		const limitPrice = calculateMarkPrice(market).sub(new BN(10000)); // 0 liquidity at current mark price
		const [newDirection, amountToPrice, _entryPrice, newMarkPrice] =
			calculateTargetPriceTrade(market, limitPrice, new BN(1000), 'base');
		assert(!amountToPrice.eq(ZERO));
		assert(newDirection == direction);

		console.log(
			convertToNumber(calculateMarkPrice(market)),
			'then short @',
			convertToNumber(limitPrice),
			newDirection,
			convertToNumber(newMarkPrice),
			'available liquidity',
			convertToNumber(amountToPrice, AMM_RESERVE_PRECISION)
		);

		assert(baseAssetAmount.gt(amountToPrice)); // assert its a partial fill of liquidity

		// const triggerPrice = new BN(0);
		// const triggerCondition = OrderTriggerCondition.BELOW;
		const orderParams = getLimitOrderParams(
			marketIndex,
			direction,
			baseAssetAmount,
			limitPrice,
			false,
			true
		);

		await clearingHouse.placeOrder(orderParams, discountTokenAccount.address);

		await clearingHouseUser.fetchAccounts();
		const order = clearingHouseUser.getUserAccount().orders[0];
		const amountToFill = calculateAmountToTradeForLimit(market, order);

		console.log(amountToFill);

		const orderId = new BN(5);
		await fillerClearingHouse.fillOrder(
			userAccountPublicKey,
			clearingHouseUser.getUserAccount(),
			order
		);

		await clearingHouse.fetchAccounts();
		await clearingHouseUser.fetchAccounts();
		await fillerUser.fetchAccounts();

		const market2 = clearingHouse.getMarketAccount(marketIndex);
		const order2 = clearingHouseUser.getUserAccount().orders[0];
		console.log(
			'order filled: ',
			convertToNumber(order.baseAssetAmount),
			'->',
			convertToNumber(order2.baseAssetAmount)
		);
		console.log(order2);
		const position = clearingHouseUser.getUserAccount().positions[0];
		console.log(
			'curPosition',
			convertToNumber(position.baseAssetAmount, AMM_RESERVE_PRECISION)
		);

		assert(order.baseAssetAmountFilled.eq(ZERO));
		assert(order.baseAssetAmount.eq(order2.baseAssetAmount));
		assert(order2.baseAssetAmountFilled.gt(ZERO));
		assert(
			order2.baseAssetAmount
				.sub(order2.baseAssetAmountFilled)
				.add(position.baseAssetAmount.abs())
				.eq(order.baseAssetAmount)
		);

		const amountToFill2 = calculateAmountToTradeForLimit(market2, order2);
		assert(amountToFill2.eq(ZERO));

		await clearingHouse.cancelOrder(orderId);
	});

	it('Max leverage fill limit short order', async () => {
		//todo, partial fill wont work on order too large
		const userLeverage0 = clearingHouseUser.getLeverage();
		console.log(
			'user initial leverage:',
			convertToNumber(userLeverage0, TEN_THOUSAND)
		);

		const direction = PositionDirection.SHORT;

		const market = clearingHouse.getMarketAccount(marketIndex);
		const limitPrice = calculateMarkPrice(market); // 0 liquidity at current mark price
		const baseAssetAmount = new BN(AMM_RESERVE_PRECISION.mul(new BN(50)));
		//long 50 base amount at $1 with ~$10 collateral (max leverage = 5x)

		const [newDirection, amountToPrice, _entryPrice, newMarkPrice] =
			calculateTargetPriceTrade(market, limitPrice, new BN(1000), 'base');
		assert(amountToPrice.eq(ZERO)); // no liquidity now

		console.log(
			convertToNumber(calculateMarkPrice(market)),
			'then short',
			convertToNumber(baseAssetAmount, AMM_RESERVE_PRECISION),

			'CRISP @',
			convertToNumber(limitPrice),
			newDirection,
			convertToNumber(newMarkPrice),
			'available liquidity',
			convertToNumber(amountToPrice, AMM_RESERVE_PRECISION)
		);

		assert(baseAssetAmount.gt(amountToPrice)); // assert its a partial fill of liquidity

		const orderParams = getLimitOrderParams(
			marketIndex,
			direction,
			baseAssetAmount,
			limitPrice,
			false,
			true
		);

		// const triggerPrice = new BN(0);
		// const triggerCondition = OrderTriggerCondition.BELOW;
		await clearingHouse.placeOrder(orderParams, discountTokenAccount.address);

		// move price to make liquidity for order @ $1.05 (5%)
		setFeedPrice(anchor.workspace.Pyth, 1.45, solUsd);
		await clearingHouse.moveAmmToPrice(
			marketIndex,
			new BN(1.45 * MARK_PRICE_PRECISION.toNumber())
		);

		await clearingHouseUser.fetchAccounts();
		const order = clearingHouseUser.getUserAccount().orders[0];
		const amountToFill = calculateAmountToTradeForLimit(market, order);

		console.log(amountToFill);

		const orderId = order.orderId;
		await fillerClearingHouse.fillOrder(
			userAccountPublicKey,
			clearingHouseUser.getUserAccount(),
			order
		);

		await clearingHouse.fetchAccounts();
		await clearingHouseUser.fetchAccounts();
		await fillerUser.fetchAccounts();

		const order1 = clearingHouseUser.getUserAccount().orders[0];
		const newMarket1 = clearingHouse.getMarketAccount(marketIndex);
		const newMarkPrice1 = calculateMarkPrice(newMarket1); // 0 liquidity at current mark price

		const userLeverage = clearingHouseUser.getLeverage();
		console.log(
			'mark price:',
			convertToNumber(newMarkPrice1, MARK_PRICE_PRECISION),
			'base filled / amt:',
			convertToNumber(order1.baseAssetAmountFilled, AMM_RESERVE_PRECISION),
			'/',
			convertToNumber(order1.baseAssetAmount, AMM_RESERVE_PRECISION),
			'\n',
			'user leverage:',
			convertToNumber(userLeverage, TEN_THOUSAND),
			'\n'
		);
		// await clearingHouse.closePosition(marketIndex);
		await clearingHouse.cancelOrder(orderId);
	});
	it('When in Max leverage short, fill limit long order to reduce to ZERO', async () => {
		//todo, partial fill wont work on order too large
		const userLeverage0 = clearingHouseUser.getLeverage();
		const prePosition = clearingHouseUser.getUserPosition(marketIndex);

		console.log(
			'user initial leverage:',
			convertToNumber(userLeverage0, TEN_THOUSAND)
		);

		const direction = PositionDirection.LONG;

		const market = clearingHouse.getMarketAccount(marketIndex);
		const limitPrice = calculateMarkPrice(market); // 0 liquidity at current mark price
		const baseAssetAmount = prePosition.baseAssetAmount.abs(); //new BN(AMM_RESERVE_PRECISION.mul(new BN(50)));
		//long 50 base amount at $1 with ~$10 collateral (max leverage = 5x)

		const [newDirection, amountToPrice, _entryPrice, newMarkPrice] =
			calculateTargetPriceTrade(market, limitPrice, new BN(1000), 'base');
		assert(amountToPrice.eq(ZERO)); // no liquidity now

		console.log(
			convertToNumber(calculateMarkPrice(market)),
			'then long',
			convertToNumber(baseAssetAmount, AMM_RESERVE_PRECISION),

			'$CRISP @',
			convertToNumber(limitPrice),
			newDirection,
			convertToNumber(newMarkPrice),
			'available liquidity',
			convertToNumber(amountToPrice, AMM_RESERVE_PRECISION)
		);

		assert(baseAssetAmount.gt(amountToPrice)); // assert its a partial fill of liquidity

		// const triggerPrice = new BN(0);
		// const triggerCondition = OrderTriggerCondition.BELOW;
		const orderParams = getLimitOrderParams(
			marketIndex,
			direction,
			baseAssetAmount,
			limitPrice,
			false,
			true
		);

		await clearingHouse.placeOrder(orderParams, discountTokenAccount.address);

		// move price to make liquidity for order @ $1.05 (5%)
		setFeedPrice(anchor.workspace.Pyth, 1.35, solUsd);
		await clearingHouse.moveAmmToPrice(
			marketIndex,
			new BN(1.35 * MARK_PRICE_PRECISION.toNumber())
		);

		const order = clearingHouseUser.getUserAccount().orders[0];
		console.log(order.status);
		// assert(order.status == OrderStatus.INIT);
		const amountToFill = calculateAmountToTradeForLimit(market, order);
		console.log(amountToFill);

		await clearingHouse.fetchAccounts();
		await clearingHouseUser.fetchAccounts();
		await fillerUser.fetchAccounts();

		const orderPriceMove = clearingHouseUser.getUserAccount().orders[0];
		const newMarketPriceMove = clearingHouse.getMarketAccount(marketIndex);
		const newMarkPricePriceMove = calculateMarkPrice(newMarketPriceMove);

		const userLeveragePriceMove = clearingHouseUser.getLeverage();

		console.log(
			'ON PRICE MOVE:\n',
			'mark price:',
			convertToNumber(newMarkPricePriceMove, MARK_PRICE_PRECISION),
			'base filled / amt:',
			convertToNumber(
				orderPriceMove.baseAssetAmountFilled,
				AMM_RESERVE_PRECISION
			),
			'/',
			convertToNumber(orderPriceMove.baseAssetAmount, AMM_RESERVE_PRECISION),
			'\n',
			'user leverage:',
			convertToNumber(userLeveragePriceMove, TEN_THOUSAND),
			'\n'
		);

		await fillerClearingHouse.fillOrder(
			userAccountPublicKey,
			clearingHouseUser.getUserAccount(),
			order
		);

		await clearingHouse.fetchAccounts();
		await clearingHouseUser.fetchAccounts();
		await fillerUser.fetchAccounts();

		const order1 = clearingHouseUser.getUserAccount().orders[0];
		const newMarket1 = clearingHouse.getMarketAccount(marketIndex);
		const newMarkPrice1 = calculateMarkPrice(newMarket1); // 0 liquidity at current mark price

		const userLeverage = clearingHouseUser.getLeverage();
		const postPosition = clearingHouseUser.getUserPosition(marketIndex);

		console.log(
			'FILLED:',
			'position: ',
			convertToNumber(prePosition.baseAssetAmount, AMM_RESERVE_PRECISION),
			'->',
			convertToNumber(postPosition.baseAssetAmount, AMM_RESERVE_PRECISION),
			'mark price:',
			convertToNumber(newMarkPrice1, MARK_PRICE_PRECISION),
			'base filled / amt:',
			convertToNumber(order1.baseAssetAmountFilled, AMM_RESERVE_PRECISION),
			'/',
			convertToNumber(order1.baseAssetAmount, AMM_RESERVE_PRECISION),
			'\n',
			'user leverage:',
			convertToNumber(userLeverage, TEN_THOUSAND),
			'\n'
		);

		// assert(userNetGain.lte(ZERO)); // ensure no funny business
		assert(userLeverage.eq(ZERO));
		assert(postPosition.baseAssetAmount.eq(ZERO));
		// await clearingHouse.closePosition(marketIndex);
		// await clearingHouse.cancelOrder(orderId);
	});

	it('Max leverage fill limit long order', async () => {
		//todo, partial fill wont work on order too large
		const userLeverage0 = clearingHouseUser.getLeverage();
		const totalCol = clearingHouseUser.getTotalCollateral();
		console.log(
			'user initial leverage:',
			convertToNumber(userLeverage0, TEN_THOUSAND)
		);

		const direction = PositionDirection.LONG;

		const market = clearingHouse.getMarketAccount(marketIndex);
		const limitPrice = calculateMarkPrice(market); // 0 liquidity at current mark price
		const baseAssetAmount = AMM_RESERVE_PRECISION.mul(
			totalCol.mul(new BN(5)).div(QUOTE_PRECISION)
		);
		//long 50 base amount at $1 with ~$10 collateral (max leverage = 5x)

		const [newDirection, amountToPrice, _entryPrice, newMarkPrice] =
			calculateTargetPriceTrade(market, limitPrice, new BN(1000), 'base');
		assert(amountToPrice.eq(ZERO)); // no liquidity now

		console.log(
			convertToNumber(calculateMarkPrice(market)),
			'then long',
			convertToNumber(baseAssetAmount, AMM_RESERVE_PRECISION),

			'$CRISP @',
			convertToNumber(limitPrice),
			newDirection,
			convertToNumber(newMarkPrice),
			'available liquidity',
			convertToNumber(amountToPrice, AMM_RESERVE_PRECISION)
		);

		assert(baseAssetAmount.gt(amountToPrice)); // assert its a partial fill of liquidity

		// const triggerPrice = new BN(0);
		// const triggerCondition = OrderTriggerCondition.BELOW;
		const orderParams = getLimitOrderParams(
			marketIndex,
			direction,
			baseAssetAmount,
			limitPrice,
			false,
			true
		);
		await clearingHouse.placeOrder(orderParams, discountTokenAccount.address);

		// move price to make liquidity for order @ $1.05 (5%)
		setFeedPrice(anchor.workspace.Pyth, 1.33, solUsd);
		await clearingHouse.moveAmmToPrice(
			marketIndex,
			new BN(1.33 * MARK_PRICE_PRECISION.toNumber())
		);

		const order = clearingHouseUser.getUserAccount().orders[0];
		const amountToFill = calculateAmountToTradeForLimit(market, order);

		console.log(amountToFill);

		const orderId = order.orderId;
		assert(order.orderId.gte(new BN(7)));
		await fillerClearingHouse.fillOrder(
			userAccountPublicKey,
			clearingHouseUser.getUserAccount(),
			order
		);

		await clearingHouse.fetchAccounts();
		await clearingHouseUser.fetchAccounts();
		await fillerUser.fetchAccounts();

		const order1 = clearingHouseUser.getUserAccount().orders[0];
		const newMarket1 = clearingHouse.getMarketAccount(marketIndex);
		const newMarkPrice1 = calculateMarkPrice(newMarket1); // 0 liquidity at current mark price

		const userLeverage = clearingHouseUser.getLeverage();

		// assert(userNetGain.lte(ZERO)); // ensure no funny business
		console.log(
			'mark price:',
			convertToNumber(newMarkPrice1, MARK_PRICE_PRECISION),
			'base filled / amt:',
			convertToNumber(order1.baseAssetAmountFilled, AMM_RESERVE_PRECISION),
			'/',
			convertToNumber(order1.baseAssetAmount, AMM_RESERVE_PRECISION),
			'\n',
			'user leverage:',
			convertToNumber(userLeverage, TEN_THOUSAND),
			'\n'
		);
		// await clearingHouse.closePosition(marketIndex);
		await clearingHouse.cancelOrder(orderId);
	});

	it('When in Max leverage long, fill limit short order to flip to max leverage short', async () => {
		// determining max leverage short is harder than max leverage long
		// (using linear assumptions since it is smaller base amt)

		const userLeverage0 = clearingHouseUser.getLeverage();
		const prePosition = clearingHouseUser.getUserPosition(marketIndex);

		console.log(
			'user initial leverage:',
			convertToNumber(userLeverage0, TEN_THOUSAND)
		);
		const direction = PositionDirection.SHORT;

		const market = clearingHouse.getMarketAccount(marketIndex);
		// const limitPrice = calculateMarkPrice(market); // 0 liquidity at current mark price
		const baseAssetAmount = prePosition.baseAssetAmount.abs().mul(new BN(2)); //new BN(AMM_RESERVE_PRECISION.mul(new BN(50)));
		const limitPrice = calculateTradeSlippage(
			direction,
			baseAssetAmount,
			market,
			'base'
		)[3];
		//long 50 base amount at $1 with ~$10 collateral (max leverage = 5x)

		const [newDirection, amountToPrice, _entryPrice, newMarkPrice] =
			calculateTargetPriceTrade(market, limitPrice, new BN(1000), 'base');

		console.log(
			convertToNumber(calculateMarkPrice(market)),
			'then long',
			convertToNumber(baseAssetAmount, AMM_RESERVE_PRECISION),

			'$CRISP @',
			convertToNumber(limitPrice),
			newDirection,
			convertToNumber(newMarkPrice),
			'available liquidity',
			convertToNumber(amountToPrice, AMM_RESERVE_PRECISION)
		);

		// assert(baseAssetAmount.gt(amountToPrice)); // assert its a partial fill of liquidity

		// const triggerPrice = new BN(0);
		// const triggerCondition = OrderTriggerCondition.BELOW;
		const orderParams = getLimitOrderParams(
			marketIndex,
			direction,
			baseAssetAmount,
			limitPrice,
			false,
			true
		);
		await clearingHouse.placeOrder(orderParams, discountTokenAccount.address);

		// move price to make liquidity for order @ $1.05 (5%)
		// setFeedPrice(anchor.workspace.Pyth, 1.55, solUsd);
		// await clearingHouse.moveAmmToPrice(
		// 	marketIndex,
		// 	new BN(1.55 * MARK_PRICE_PRECISION.toNumber())
		// );

		await clearingHouseUser.fetchAccounts();
		const order = clearingHouse.getUserAccount().orders[0];
		console.log(order.status);
		// assert(order.status == OrderStatus.INIT);
		const amountToFill = calculateAmountToTradeForLimit(market, order);
		console.log(amountToFill);

		await clearingHouse.fetchAccounts();
		await clearingHouseUser.fetchAccounts();
		await fillerUser.fetchAccounts();

		const orderPriceMove = clearingHouseUser.getUserAccount().orders[0];
		const newMarketPriceMove = clearingHouse.getMarketAccount(marketIndex);
		const newMarkPricePriceMove = calculateMarkPrice(newMarketPriceMove);

		const userLeveragePriceMove = clearingHouseUser.getLeverage();

		console.log(
			'ON PRICE MOVE:\n',
			'mark price:',
			convertToNumber(newMarkPricePriceMove, MARK_PRICE_PRECISION),
			'base filled / amt:',
			convertToNumber(
				orderPriceMove.baseAssetAmountFilled,
				AMM_RESERVE_PRECISION
			),
			'/',
			convertToNumber(orderPriceMove.baseAssetAmount, AMM_RESERVE_PRECISION),
			'\n',
			'user leverage:',
			convertToNumber(userLeveragePriceMove, TEN_THOUSAND),
			'\n'
		);

		await fillerClearingHouse.fillOrder(
			userAccountPublicKey,
			clearingHouseUser.getUserAccount(),
			order
		);

		await clearingHouse.fetchAccounts();
		await clearingHouseUser.fetchAccounts();
		await fillerUser.fetchAccounts();

		const order1 = clearingHouseUser.getUserAccount().orders[0];
		const newMarket1 = clearingHouse.getMarketAccount(marketIndex);
		const newMarkPrice1 = calculateMarkPrice(newMarket1); // 0 liquidity at current mark price

		const userLeverage = clearingHouseUser.getLeverage();
		const postPosition = clearingHouseUser.getUserPosition(marketIndex);

		console.log(
			'FILLED:',
			'position: ',
			convertToNumber(prePosition.baseAssetAmount, AMM_RESERVE_PRECISION),
			'->',
			convertToNumber(postPosition.baseAssetAmount, AMM_RESERVE_PRECISION),
			'mark price:',
			convertToNumber(newMarkPrice1, MARK_PRICE_PRECISION),
			'base filled / amt:',
			convertToNumber(order1.baseAssetAmountFilled, AMM_RESERVE_PRECISION),
			'/',
			convertToNumber(order1.baseAssetAmount, AMM_RESERVE_PRECISION),
			'\n',
			'user leverage:',
			convertToNumber(userLeverage, TEN_THOUSAND),
			'\n'
		);

		await clearingHouse.closePosition(marketIndex);
		await clearingHouse.cancelOrder(order.orderId);

		assert(userLeverage.gt(new BN(0)));
		assert(postPosition.baseAssetAmount.lt(ZERO));
	});

	it('Round up when residual base_asset_fill left is <= minimum tick size (LONG BTC)', async () => {
		//todo, partial fill wont work on order too large
		const userLeverage0 = clearingHouseUser.getLeverage();
		const userTotalCollatearl = clearingHouseUser.getTotalCollateral();

		console.log(
			'user collatearl',
			convertToNumber(userTotalCollatearl),
			'user initial leverage:',
			convertToNumber(userLeverage0, TEN_THOUSAND)
		);

		const direction = PositionDirection.LONG;

		const market = clearingHouse.getMarketAccount(marketIndexBTC);
		const baseAssetAmount = new BN(AMM_RESERVE_PRECISION.div(new BN(10000)));
		const limitPrice = calculateTradeSlippage(
			direction,
			baseAssetAmount,
			market,
			'base'
		)[3].sub(new BN(1000)); // tiny residual liquidity would be remaining if filled up to price

		//long 50 base amount at $1 with ~$10 collateral (max leverage = 5x)

		const [newDirection, amountToPrice, _entryPrice, newMarkPrice] =
			calculateTargetPriceTrade(market, limitPrice, new BN(1000), 'base');

		console.log(
			convertToNumber(calculateMarkPrice(market)),
			'then long',
			convertToNumber(baseAssetAmount, AMM_RESERVE_PRECISION),

			'$CRISP @',
			convertToNumber(limitPrice),
			newDirection,
			convertToNumber(newMarkPrice),
			'available liquidity',
			convertToNumber(amountToPrice, AMM_RESERVE_PRECISION)
		);

		assert(baseAssetAmount.gt(amountToPrice)); // assert its a partial fill of liquidity

		// const triggerPrice = new BN(0);
		// const triggerCondition = OrderTriggerCondition.BELOW;
		const orderParams = getLimitOrderParams(
			marketIndexBTC,
			direction,
			baseAssetAmount,
			limitPrice,
			false,
			true
		);
		await clearingHouse.placeOrder(orderParams, discountTokenAccount.address);

		await clearingHouseUser.fetchAccounts();

		const order = clearingHouseUser.getUserAccount().orders[0];
		const amountToFill = calculateAmountToTradeForLimit(market, order);

		console.log(convertToNumber(amountToFill, AMM_RESERVE_PRECISION));

		const prePosition = clearingHouseUser.getUserPosition(marketIndexBTC);

		const orderId = order.orderId;
		await fillerClearingHouse.fillOrder(
			userAccountPublicKey,
			clearingHouseUser.getUserAccount(),
			order
		);

		await clearingHouse.fetchAccounts();
		await clearingHouseUser.fetchAccounts();
		await fillerUser.fetchAccounts();

		const newMarket1 = clearingHouse.getMarketAccount(marketIndexBTC);
		const newMarkPrice1 = calculateMarkPrice(newMarket1);

		const postPosition = clearingHouseUser.getUserPosition(marketIndexBTC);
		console.log(
			'User position: ',
			convertToNumber(prePosition.baseAssetAmount, AMM_RESERVE_PRECISION),
			'->',
			convertToNumber(postPosition.baseAssetAmount, AMM_RESERVE_PRECISION)
		);

		console.log(
			'assert: ',
			convertToNumber(newMarkPrice1),
			'<',
			convertToNumber(limitPrice)
		);
		assert(newMarkPrice1.gt(limitPrice)); // rounded up long pushes price slightly above limit
		assert(
			postPosition.baseAssetAmount.abs().gt(prePosition.baseAssetAmount.abs())
		);
		await clearingHouse.closePosition(marketIndexBTC);

		// ensure order no longer exists
		try {
			await clearingHouse.cancelOrder(orderId);
		} catch (e) {
			return;
		}

		assert(false);
	});
	it('Round up when residual base_asset_fill left is <= minimum tick size (SHORT BTC)', async () => {
		//todo, partial fill wont work on order too large
		const userLeverage0 = clearingHouseUser.getLeverage();
		console.log(
			'user initial leverage:',
			convertToNumber(userLeverage0, TEN_THOUSAND)
		);

		const direction = PositionDirection.SHORT;

		const market = clearingHouse.getMarketAccount(marketIndexBTC);
		const baseAssetAmount = new BN(AMM_RESERVE_PRECISION.div(new BN(10000)));
		const limitPrice = calculateTradeSlippage(
			direction,
			baseAssetAmount,
			market,
			'base'
		)[3].add(new BN(1000)); // tiny residual liquidity would be remaining if filled up to price

		//long 50 base amount at $1 with ~$10 collateral (max leverage = 5x)

		const [newDirection, amountToPrice, _entryPrice, newMarkPrice] =
			calculateTargetPriceTrade(market, limitPrice, new BN(1000), 'base');

		console.log(
			convertToNumber(calculateMarkPrice(market)),
			'then long',
			convertToNumber(baseAssetAmount, AMM_RESERVE_PRECISION),

			'$CRISP @',
			convertToNumber(limitPrice),
			newDirection,
			convertToNumber(newMarkPrice),
			'available liquidity',
			convertToNumber(amountToPrice, AMM_RESERVE_PRECISION)
		);

		assert(baseAssetAmount.gt(amountToPrice)); // assert its a partial fill of liquidity

		// const triggerPrice = new BN(0);
		// const triggerCondition = OrderTriggerCondition.BELOW;
		const orderParams = getLimitOrderParams(
			marketIndexBTC,
			direction,
			baseAssetAmount,
			limitPrice,
			false,
			true
		);
		await clearingHouse.placeOrder(orderParams, discountTokenAccount.address);

		await clearingHouseUser.fetchAccounts();

		const order = clearingHouseUser.getUserAccount().orders[0];
		const amountToFill = calculateAmountToTradeForLimit(market, order);

		console.log(convertToNumber(amountToFill, AMM_RESERVE_PRECISION));

		const prePosition = clearingHouseUser.getUserPosition(marketIndexBTC);

		const orderId = order.orderId;
		await fillerClearingHouse.fillOrder(
			userAccountPublicKey,
			clearingHouseUser.getUserAccount(),
			order
		);

		await clearingHouse.fetchAccounts();
		await clearingHouseUser.fetchAccounts();
		await fillerUser.fetchAccounts();

		const newMarket1 = clearingHouse.getMarketAccount(marketIndexBTC);
		const newMarkPrice1 = calculateMarkPrice(newMarket1);
		console.log(
			'assert: ',
			convertToNumber(newMarkPrice1),
			'>',
			convertToNumber(limitPrice)
		);
		assert(newMarkPrice1.lt(limitPrice)); // rounded up long pushes price slightly above limit

		const postPosition = clearingHouseUser.getUserPosition(marketIndexBTC);
		console.log(
			'User position: ',
			convertToNumber(prePosition.baseAssetAmount, AMM_RESERVE_PRECISION),
			'->',
			convertToNumber(postPosition.baseAssetAmount, AMM_RESERVE_PRECISION)
		);
		assert(
			postPosition.baseAssetAmount.abs().gt(prePosition.baseAssetAmount.abs())
		);

		await clearingHouse.closePosition(marketIndexBTC);

		// ensure order no longer exists
		try {
			await clearingHouse.cancelOrder(orderId);
		} catch (e) {
			return;
		}

		assert(false);
	});

	it('PlaceAndFill LONG Order 100% filled', async () => {
		const direction = PositionDirection.LONG;
		const baseAssetAmount = new BN(AMM_RESERVE_PRECISION);
		const price = MARK_PRICE_PRECISION.mul(new BN(2));

		await clearingHouseUser.fetchAccounts();
		const prePosition = clearingHouseUser.getUserPosition(marketIndex);
		console.log(prePosition);
		assert(prePosition.baseAssetAmount.eq(ZERO)); // no existing position

		const fillerCollateralBefore =
			fillerClearingHouse.getQuoteAssetTokenAmount();

		const orderParams = getLimitOrderParams(
			marketIndex,
			direction,
			baseAssetAmount,
			price,
			false,
			true
		);
		const txSig = await clearingHouse.placeAndFillOrder(
			orderParams,
			discountTokenAccount.address
		);

		const computeUnits = await findComputeUnitConsumption(
			clearingHouse.program.programId,
			connection,
			txSig
		);
		console.log('placeAndFill compute units', computeUnits[0]);

		await clearingHouse.settlePNL(
			await clearingHouse.getUserAccountPublicKey(),
			clearingHouse.getUserAccount(),
			marketIndex
		);

		await clearingHouse.fetchAccounts();
		await clearingHouseUser.fetchAccounts();
		await fillerUser.fetchAccounts();

		const postPosition = clearingHouseUser.getUserPosition(marketIndex);
		console.log(
			'User position: ',
			convertToNumber(new BN(0), AMM_RESERVE_PRECISION),
			'->',
			convertToNumber(postPosition.baseAssetAmount, AMM_RESERVE_PRECISION)
		);
		assert(postPosition.baseAssetAmount.abs().gt(new BN(0)));
		assert(postPosition.baseAssetAmount.eq(baseAssetAmount)); // 100% filled

		// zero filler reward
		const fillerReward = fillerCollateralBefore.sub(
			fillerClearingHouse.getQuoteAssetTokenAmount()
		);
		console.log(
			'FillerReward: $',
			convertToNumber(fillerReward, QUOTE_PRECISION)
		);
		assert(fillerReward.eq(new BN(0)));

		await clearingHouse.closePosition(marketIndex);
	});

	it('PlaceAndFill LONG Order multiple fills', async () => {
		// todo: check order/trade account history and make sure they match expectations
		const direction = PositionDirection.LONG;
		const baseAssetAmount = new BN(AMM_RESERVE_PRECISION);

		const market = clearingHouse.getMarketAccount(marketIndex);
		const limitPrice = calculateTradeSlippage(
			direction,
			baseAssetAmount,
			market,
			'base'
		)[2]; // set entryPrice as limit

		const prePosition = clearingHouseUser.getUserPosition(marketIndex);
		console.log(prePosition.baseAssetAmount.toString());
		// assert(prePosition==undefined); // no existing position

		const fillerCollateralBefore =
			fillerClearingHouse.getQuoteAssetTokenAmount();

		const orderParams = getLimitOrderParams(
			marketIndex,
			direction,
			baseAssetAmount,
			limitPrice,
			false,
			true
		);
		await clearingHouse.placeAndFillOrder(
			orderParams,
			discountTokenAccount.address
		);

		await clearingHouse.fetchAccounts();
		await clearingHouseUser.fetchAccounts();
		await fillerUser.fetchAccounts();

		const postPosition = clearingHouseUser.getUserPosition(marketIndex);
		console.log(
			'User position: ',
			convertToNumber(new BN(0), AMM_RESERVE_PRECISION),
			'->',
			convertToNumber(postPosition.baseAssetAmount, AMM_RESERVE_PRECISION)
		);
		assert(postPosition.baseAssetAmount.abs().gt(new BN(0)));

		// fill again

		const order = clearingHouseUser.getUserAccount().orders[0];
		const amountToFill = calculateAmountToTradeForLimit(market, order);

		console.log(convertToNumber(amountToFill, AMM_RESERVE_PRECISION));
		const market2 = clearingHouse.getMarketAccount(marketIndex);

		const markPrice2 = calculateMarkPrice(market2);
		// move price to make liquidity for order @ $1.05 (5%)
		setFeedPrice(anchor.workspace.Pyth, 0.7, solUsd);
		await clearingHouse.moveAmmToPrice(
			marketIndex,
			new BN(0.7 * MARK_PRICE_PRECISION.toNumber())
		);
		const market3 = clearingHouse.getMarketAccount(marketIndex);

		const markPrice3 = calculateMarkPrice(market3);
		console.log(
			'Market Price:',
			convertToNumber(markPrice2),
			'->',
			convertToNumber(markPrice3)
		);

		await fillerClearingHouse.fillOrder(
			userAccountPublicKey,
			clearingHouseUser.getUserAccount(),
			order
		);

		await fillerClearingHouse.settlePNL(
			await fillerClearingHouse.getUserAccountPublicKey(),
			fillerClearingHouse.getUserAccount(),
			marketIndex
		);

		await clearingHouse.settlePNL(
			await clearingHouse.getUserAccountPublicKey(),
			clearingHouse.getUserAccount(),
			marketIndex
		);

		await clearingHouseUser.fetchAccounts();
		const postPosition2 = clearingHouseUser.getUserPosition(marketIndex);
		console.log(
			'Filler: User position: ',
			convertToNumber(postPosition.baseAssetAmount, AMM_RESERVE_PRECISION),
			'->',
			convertToNumber(postPosition2.baseAssetAmount, AMM_RESERVE_PRECISION)
		);

		assert(postPosition2.baseAssetAmount.eq(baseAssetAmount)); // 100% filled

		// other part filler reward
		const fillerReward = fillerClearingHouse
			.getQuoteAssetTokenAmount()
			.sub(fillerCollateralBefore);
		console.log(
			'FillerReward: $',
			convertToNumber(fillerReward, QUOTE_PRECISION)
		);
		assert(fillerReward.gt(new BN(0)));
		await clearingHouse.closePosition(marketIndex);
	});

	it('Block whale trade > reserves', async () => {
		const direction = PositionDirection.SHORT;

		// whale trade
		const baseAssetAmount = new BN(
			AMM_RESERVE_PRECISION.mul(usdcAmountWhale).div(QUOTE_PRECISION)
		);
		const triggerPrice = MARK_PRICE_PRECISION;
		const triggerCondition = OrderTriggerCondition.ABOVE;

		const orderParams = getTriggerMarketOrderParams(
			marketIndex,
			direction,
			baseAssetAmount,
			triggerPrice,
			triggerCondition,
			false,
			false
		);
		await whaleClearingHouse.placeOrder(orderParams);

		await whaleClearingHouse.fetchAccounts();
		await whaleUser.fetchAccounts();
		await fillerUser.fetchAccounts();

		const orderIndex = new BN(0);
		const order = whaleUser.getUserAccount().orders[orderIndex.toString()];
		try {
			await whaleClearingHouse.fillOrder(
				whaleAccountPublicKey,
				whaleUser.getUserAccount(),
				order
			);
		} catch (e) {
			await whaleClearingHouse.cancelOrder(order.orderId);
			return;
		}

		assert(false);
	});

	it('Time-based fee reward cap', async () => {
		const direction = PositionDirection.SHORT;
		const baseAssetAmount = new BN(AMM_RESERVE_PRECISION.mul(new BN(10000)));
		const market0 = clearingHouse.getMarketAccount(marketIndex);
		const triggerPrice = calculateMarkPrice(market0).sub(new BN(1));
		const triggerCondition = OrderTriggerCondition.ABOVE;

		const orderParams = getTriggerMarketOrderParams(
			marketIndex,
			direction,
			baseAssetAmount,
			triggerPrice,
			triggerCondition,
			false,
			false
		);
		await whaleClearingHouse.placeOrder(orderParams);

		await whaleClearingHouse.fetchAccounts();
		await whaleUser.fetchAccounts();
		await fillerUser.fetchAccounts();

		const orderIndex = new BN(0);
		const order = whaleUser.getUserAccount().orders[orderIndex.toString()];
		const fillerCollateralBefore =
			fillerClearingHouse.getQuoteAssetTokenAmount();
		const fillerUnsettledPNLBefore =
			fillerClearingHouse.getUserAccount().positions[0].unsettledPnl;

		await fillerClearingHouse.fillOrder(
			whaleAccountPublicKey,
			whaleUser.getUserAccount(),
			order
		);

		await clearingHouse.settlePNL(
			await clearingHouse.getUserAccountPublicKey(),
			clearingHouse.getUserAccount(),
			marketIndex
		);

		await fillerClearingHouse.settlePNL(
			await fillerClearingHouse.getUserAccountPublicKey(),
			fillerClearingHouse.getUserAccount(),
			marketIndex
		);

		await whaleClearingHouse.fetchAccounts();
		await whaleUser.fetchAccounts();
		await fillerUser.fetchAccounts();

		const whaleUserAccount = whaleUser.getUserAccount();
		console.log(
			'whaleFee:',
			convertToNumber(whaleUserAccount.totalFeePaid, QUOTE_PRECISION)
		);

		const expectedFillerReward = new BN(1e6 / 100); //1 cent
		const fillerReward = fillerClearingHouse
			.getQuoteAssetTokenAmount()
			.sub(fillerCollateralBefore);
		console.log(
			'FillerReward: $',
			convertToNumber(fillerReward, QUOTE_PRECISION)
		);
		assert(
			fillerClearingHouse
				.getQuoteAssetTokenAmount()
				.sub(fillerCollateralBefore.add(fillerUnsettledPNLBefore))
				.eq(expectedFillerReward)
		);

		assert(whaleUserAccount.totalFeePaid.gt(fillerReward.mul(new BN(100))));
		// ensure whale fee more than x100 filler
	});

	it('reduce only', async () => {
		const openPositionOrderParams = getMarketOrderParams(
			marketIndexEth,
			PositionDirection.SHORT,
			ZERO,
			AMM_RESERVE_PRECISION,
			false
		);
		await clearingHouse.placeAndFillOrder(openPositionOrderParams);

		const reduceMarketOrderParams = getMarketOrderParams(
			marketIndexEth,
			PositionDirection.LONG,
			ZERO,
			TWO.mul(AMM_RESERVE_PRECISION),
			true
		);
		await clearingHouse.placeAndFillOrder(reduceMarketOrderParams);
		await clearingHouse.fetchAccounts();
		await clearingHouseUser.fetchAccounts();

		let orderRecord = eventSubscriber.getEventsArray('OrderRecord')[0];
		assert(orderRecord.baseAssetAmountFilled.eq(AMM_RESERVE_PRECISION));
		assert(
			isVariant(clearingHouseUser.getUserAccount().orders[0].status, 'init')
		);

		await clearingHouse.placeAndFillOrder(openPositionOrderParams);
		const reduceLimitOrderParams = getLimitOrderParams(
			marketIndexEth,
			PositionDirection.LONG,
			TWO.mul(AMM_RESERVE_PRECISION),
			TWO.mul(MARK_PRICE_PRECISION),
			true
		);
		await clearingHouse.placeAndFillOrder(reduceLimitOrderParams);

		await clearingHouse.settlePNL(
			await clearingHouse.getUserAccountPublicKey(),
			clearingHouse.getUserAccount(),
			marketIndex
		);

		await clearingHouse.fetchAccounts();
		await clearingHouseUser.fetchAccounts();

		orderRecord = eventSubscriber.getEventsArray('OrderRecord')[0];
		assert(orderRecord.baseAssetAmountFilled.eq(AMM_RESERVE_PRECISION));
		assert(
			isVariant(clearingHouseUser.getUserAccount().orders[0].status, 'open')
		);

		assert(
			clearingHouseUser
				.getUserAccount()
				.orders[0].baseAssetAmountFilled.eq(AMM_RESERVE_PRECISION)
		);
	});
});
