use crate::constants::{MARK_PRICE_MANTISSA, PEG_PRECISION};
use crate::math::bn::U256;

pub fn calculate_base_asset_price_with_mantissa(
    unpegged_quote_asset_amount: u128,
    base_asset_amount: u128,
    peg_multiplier: u128,
) -> u128 {
    let peg_quote_asset_amount = unpegged_quote_asset_amount
        .checked_mul(peg_multiplier)
        .unwrap();

    let ast_px = U256::from(peg_quote_asset_amount)
        .checked_mul(U256::from(
            MARK_PRICE_MANTISSA.checked_div(PEG_PRECISION).unwrap(),
        ))
        .unwrap()
        .checked_div(U256::from(base_asset_amount))
        .unwrap()
        .try_to_u128()
        .unwrap();

    return ast_px;
}