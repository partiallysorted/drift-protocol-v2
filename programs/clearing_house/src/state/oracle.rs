use anchor_lang::prelude::*;

use crate::error::ClearingHouseResult;
use crate::math::casting::{cast, cast_to_i128, cast_to_i64, cast_to_u128};
use crate::math::constants::{MARK_PRICE_PRECISION, MARK_PRICE_PRECISION_I128};
use crate::math_error;
use solana_program::msg;
use std::cmp::max;
use switchboard_v2::decimal::SwitchboardDecimal;
use switchboard_v2::AggregatorAccountData;

#[derive(AnchorSerialize, AnchorDeserialize, Clone, Copy, Eq, PartialEq)]
pub enum OracleSource {
    Pyth,
    Switchboard,
    QuoteAsset,
}

impl Default for OracleSource {
    // UpOnly
    fn default() -> Self {
        OracleSource::Pyth
    }
}

#[derive(Default, Clone, Copy, Debug)]
pub struct OraclePriceData {
    pub price: i128,
    pub confidence: u128,
    pub delay: i64,
    pub has_sufficient_number_of_data_points: bool,
}

pub fn get_oracle_price(
    oracle_source: &OracleSource,
    price_oracle: &AccountInfo,
    clock_slot: u64,
) -> ClearingHouseResult<OraclePriceData> {
    match oracle_source {
        OracleSource::Pyth => get_pyth_price(price_oracle, clock_slot),
        OracleSource::Switchboard => get_switchboard_price(price_oracle, clock_slot),
        OracleSource::QuoteAsset => Ok(OraclePriceData {
            price: MARK_PRICE_PRECISION_I128,
            confidence: 1,
            delay: 0,
            has_sufficient_number_of_data_points: true,
        }),
    }
}

pub fn get_pyth_price(
    price_oracle: &AccountInfo,
    clock_slot: u64,
) -> ClearingHouseResult<OraclePriceData> {
    let pyth_price_data = price_oracle
        .try_borrow_data()
        .or(Err(crate::error::ErrorCode::UnableToLoadOracle))?;
    let price_data = pyth_client::cast::<pyth_client::Price>(&pyth_price_data);

    let oracle_price = cast_to_i128(price_data.agg.price)?;
    let oracle_conf = cast_to_u128(price_data.agg.conf)?;

    let oracle_precision = 10_u128.pow(price_data.expo.unsigned_abs());

    let mut oracle_scale_mult = 1;
    let mut oracle_scale_div = 1;

    if oracle_precision > MARK_PRICE_PRECISION {
        oracle_scale_div = oracle_precision
            .checked_div(MARK_PRICE_PRECISION)
            .ok_or_else(math_error!())?;
    } else {
        oracle_scale_mult = MARK_PRICE_PRECISION
            .checked_div(oracle_precision)
            .ok_or_else(math_error!())?;
    }

    let oracle_price_scaled = (oracle_price)
        .checked_mul(cast(oracle_scale_mult)?)
        .ok_or_else(math_error!())?
        .checked_div(cast(oracle_scale_div)?)
        .ok_or_else(math_error!())?;

    let oracle_conf_scaled = (oracle_conf)
        .checked_mul(oracle_scale_mult)
        .ok_or_else(math_error!())?
        .checked_div(oracle_scale_div)
        .ok_or_else(math_error!())?;

    let oracle_delay: i64 = cast_to_i64(clock_slot)?
        .checked_sub(cast(price_data.valid_slot)?)
        .ok_or_else(math_error!())?;

    Ok(OraclePriceData {
        price: oracle_price_scaled,
        confidence: oracle_conf_scaled,
        delay: oracle_delay,
        has_sufficient_number_of_data_points: true,
    })
}

pub fn get_switchboard_price(
    price_oracle: &AccountInfo,
    clock_slot: u64,
) -> ClearingHouseResult<OraclePriceData> {
    let aggregator_data = AggregatorAccountData::new(price_oracle)
        .or(Err(crate::error::ErrorCode::UnableToLoadOracle))?;

    let price = convert_switchboard_decimal(&aggregator_data.latest_confirmed_round.result)?;
    let confidence =
        convert_switchboard_decimal(&aggregator_data.latest_confirmed_round.std_deviation)?;

    // std deviation should always be positive, if we get a negative make it u128::MAX so it's flagged as bad value
    let confidence = if confidence < 0 {
        u128::MAX
    } else {
        let price_10bps = price
            .unsigned_abs()
            .checked_div(1000)
            .ok_or_else(math_error!())?;
        max(confidence.unsigned_abs(), price_10bps)
    };

    let delay: i64 = cast_to_i64(clock_slot)?
        .checked_sub(cast(
            aggregator_data.latest_confirmed_round.round_open_slot,
        )?)
        .ok_or_else(math_error!())?;

    let has_sufficient_number_of_data_points =
        aggregator_data.latest_confirmed_round.num_success >= aggregator_data.min_oracle_results;

    Ok(OraclePriceData {
        price,
        confidence,
        delay,
        has_sufficient_number_of_data_points,
    })
}

/// Given a decimal number represented as a mantissa (the digits) plus an
/// original_precision (10.pow(some number of decimals)), scale the
/// mantissa/digits to make sense with a new_precision.
fn convert_switchboard_decimal(
    switchboard_decimal: &SwitchboardDecimal,
) -> ClearingHouseResult<i128> {
    let switchboard_precision = 10_u128.pow(switchboard_decimal.scale);
    if switchboard_precision > MARK_PRICE_PRECISION {
        switchboard_decimal
            .mantissa
            .checked_div((switchboard_precision / MARK_PRICE_PRECISION) as i128)
            .ok_or_else(math_error!())
    } else {
        switchboard_decimal
            .mantissa
            .checked_mul((MARK_PRICE_PRECISION / switchboard_precision) as i128)
            .ok_or_else(math_error!())
    }
}
