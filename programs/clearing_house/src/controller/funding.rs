use std::cmp::{max, min};

use anchor_lang::prelude::*;
use solana_program::clock::UnixTimestamp;
use solana_program::msg;

use crate::error::ClearingHouseResult;
use crate::get_then_update_id;
use crate::math::amm;
use crate::math::casting::{cast, cast_to_i128};
use crate::math::constants::{
    AMM_TO_QUOTE_PRECISION_RATIO_I128, FUNDING_PAYMENT_PRECISION, ONE_HOUR,
};
use crate::math::funding::{calculate_funding_payment, calculate_funding_rate_long_short};
use crate::math::oracle;
use crate::math_error;
use crate::state::events::{FundingPaymentRecord, FundingRateRecord};
use crate::state::market::{Market, AMM};
use crate::state::market_map::MarketMap;
use crate::state::state::OracleGuardRails;
use crate::state::user::User;

pub fn settle_funding_payment(
    user: &mut User,
    user_key: &Pubkey,
    market_map: &MarketMap,
    now: UnixTimestamp,
) -> ClearingHouseResult {
    for market_position in user.positions.iter_mut() {
        if market_position.base_asset_amount == 0 {
            continue;
        }

        let market = &market_map.get_ref(&market_position.market_index)?;
        let amm: &AMM = &market.amm;

        let amm_cumulative_funding_rate = if market_position.base_asset_amount > 0 {
            amm.cumulative_funding_rate_long
        } else {
            amm.cumulative_funding_rate_short
        };

        if amm_cumulative_funding_rate != market_position.last_cumulative_funding_rate {
            let market_funding_payment =
                calculate_funding_payment(amm_cumulative_funding_rate, market_position)?
                    .checked_div(AMM_TO_QUOTE_PRECISION_RATIO_I128)
                    .ok_or_else(math_error!())?;

            emit!(FundingPaymentRecord {
                ts: now,
                user_authority: user.authority,
                user: *user_key,
                market_index: market_position.market_index,
                funding_payment: market_funding_payment, //10e13
                user_last_cumulative_funding: market_position.last_cumulative_funding_rate, //10e14
                user_last_funding_rate_ts: market_position.last_funding_rate_ts,
                amm_cumulative_funding_long: amm.cumulative_funding_rate_long, //10e14
                amm_cumulative_funding_short: amm.cumulative_funding_rate_short, //10e14
                base_asset_amount: market_position.base_asset_amount,          //10e13
            });

            market_position.last_cumulative_funding_rate = amm_cumulative_funding_rate;
            market_position.last_funding_rate_ts = amm.last_funding_rate_ts;
            market_position.unsettled_pnl = market_position
                .unsettled_pnl
                .checked_add(market_funding_payment)
                .ok_or_else(math_error!())?;
        }
    }

    Ok(())
}

pub fn update_funding_rate(
    market_index: u64,
    market: &mut Market,
    price_oracle: &AccountInfo,
    now: UnixTimestamp,
    clock_slot: u64,
    guard_rails: &OracleGuardRails,
    funding_paused: bool,
    precomputed_mark_price: Option<u128>,
) -> ClearingHouseResult {
    let time_since_last_update = now
        .checked_sub(market.amm.last_funding_rate_ts)
        .ok_or_else(math_error!())?;

    // Pause funding if oracle is invalid or if mark/oracle spread is too divergent
    let (block_funding_rate_update, oracle_price_data) = oracle::block_operation(
        &market.amm,
        price_oracle,
        clock_slot,
        guard_rails,
        precomputed_mark_price,
    )?;
    // round next update time to be available on the hour
    let mut next_update_wait = market.amm.funding_period;
    if market.amm.funding_period > 1 {
        let last_update_delay = market
            .amm
            .last_funding_rate_ts
            .rem_euclid(market.amm.funding_period);
        if last_update_delay != 0 {
            let max_delay_for_next_period = market
                .amm
                .funding_period
                .checked_div(3)
                .ok_or_else(math_error!())?;

            let two_funding_periods = market
                .amm
                .funding_period
                .checked_mul(2)
                .ok_or_else(math_error!())?;

            if last_update_delay > max_delay_for_next_period {
                // too late for on the hour next period, delay to following period
                next_update_wait = two_funding_periods
                    .checked_sub(last_update_delay)
                    .ok_or_else(math_error!())?;
            } else {
                // allow update on the hour
                next_update_wait = market
                    .amm
                    .funding_period
                    .checked_sub(last_update_delay)
                    .ok_or_else(math_error!())?;
            }

            if next_update_wait > two_funding_periods {
                next_update_wait = next_update_wait
                    .checked_sub(market.amm.funding_period)
                    .ok_or_else(math_error!())?;
            }
        }
    }

    if !funding_paused && !block_funding_rate_update && time_since_last_update >= next_update_wait {
        let oracle_price_twap = amm::update_oracle_price_twap(
            &mut market.amm,
            now,
            &oracle_price_data,
            precomputed_mark_price,
        )?;
        let mid_price_twap = amm::update_mark_twap(&mut market.amm, now, None)?;

        let period_adjustment = (24_i128)
            .checked_mul(ONE_HOUR)
            .ok_or_else(math_error!())?
            .checked_div(max(ONE_HOUR, market.amm.funding_period as i128))
            .ok_or_else(math_error!())?;
        // funding period = 1 hour, window = 1 day
        // low periodicity => quickly updating/settled funding rates => lower funding rate payment per interval
        let price_spread = cast_to_i128(mid_price_twap)?
            .checked_sub(oracle_price_twap)
            .ok_or_else(math_error!())?;

        // clamp price divergence to 3% for funding rate calculation
        let max_price_spread = oracle_price_twap
            .checked_div(33)
            .ok_or_else(math_error!())?; // 3%
        let clamped_price_spread = max(-max_price_spread, min(price_spread, max_price_spread));

        let funding_rate = clamped_price_spread
            .checked_mul(cast(FUNDING_PAYMENT_PRECISION)?)
            .ok_or_else(math_error!())?
            .checked_div(cast(period_adjustment)?)
            .ok_or_else(math_error!())?;

        let (funding_rate_long, funding_rate_short) =
            calculate_funding_rate_long_short(market, funding_rate)?;

        market.amm.cumulative_funding_rate_long = market
            .amm
            .cumulative_funding_rate_long
            .checked_add(funding_rate_long)
            .ok_or_else(math_error!())?;

        market.amm.cumulative_funding_rate_short = market
            .amm
            .cumulative_funding_rate_short
            .checked_add(funding_rate_short)
            .ok_or_else(math_error!())?;

        market.amm.last_funding_rate = funding_rate;
        market.amm.last_funding_rate_ts = now;

        emit!(FundingRateRecord {
            ts: now,
            record_id: get_then_update_id!(market, next_funding_rate_record_id),
            market_index,
            funding_rate,
            cumulative_funding_rate_long: market.amm.cumulative_funding_rate_long,
            cumulative_funding_rate_short: market.amm.cumulative_funding_rate_short,
            mark_price_twap: mid_price_twap,
            oracle_price_twap,
        });
    }

    Ok(())
}
