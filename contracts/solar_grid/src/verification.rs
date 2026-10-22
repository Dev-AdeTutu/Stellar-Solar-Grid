//! Formally specified arithmetic used by the contract (see contracts/VERIFICATION.md).
//!
//! Each function carries its specification as pre/post-conditions; the
//! `kani_proofs` module proves them for *all* inputs with the Kani model checker.

/// Credit a balance. Pre: amount > 0. Post: result = balance + amount, no overflow.
pub fn credit(balance: i128, amount: i128) -> Option<i128> {
    if amount <= 0 || balance < 0 {
        return None;
    }
    balance.checked_add(amount)
}

/// Debit a balance. Post: result >= 0 and result = balance - amount.
pub fn debit(balance: i128, amount: i128) -> Option<i128> {
    if amount <= 0 || balance < 0 || amount > balance {
        return None;
    }
    Some(balance - amount)
}

/// Pro-rata share in basis points. Post: 0 <= result <= amount.
pub fn bps_share(amount: i128, bps: u32) -> Option<i128> {
    if amount < 0 || bps > 10_000 {
        return None;
    }
    amount.checked_mul(bps as i128).map(|v| v / 10_000)
}

/// Units accumulation. Post: result >= units, no u64 overflow.
pub fn add_units(units: u64, delta: u64) -> Option<u64> {
    units.checked_add(delta)
}

#[cfg(kani)]
mod kani_proofs {
    use super::*;

    #[kani::proof]
    fn credit_never_negative_or_overflows() {
        let (b, a): (i128, i128) = (kani::any(), kani::any());
        if let Some(r) = credit(b, a) {
            assert!(r >= 0 && r > b && r - a == b);
        }
    }

    #[kani::proof]
    fn debit_keeps_balance_non_negative() {
        let (b, a): (i128, i128) = (kani::any(), kani::any());
        if let Some(r) = debit(b, a) {
            assert!(r >= 0 && r + a == b);
        }
    }

    #[kani::proof]
    fn bps_share_bounded() {
        let (a, bps): (i128, u32) = (kani::any(), kani::any());
        if let Some(r) = bps_share(a, bps) {
            assert!(r >= 0 && r <= a);
        }
    }

    #[kani::proof]
    fn add_units_monotonic() {
        let (u, d): (u64, u64) = (kani::any(), kani::any());
        if let Some(r) = add_units(u, d) {
            assert!(r >= u);
        }
    }

    #[kani::proof]
    fn fee_split_conserves_value() {
        let fee: i128 = kani::any();
        kani::assume(fee >= 0 && fee <= i128::MAX / 10_000);
        let (c, p) = crate::algo_market::split_fee(fee);
        assert!(c >= 0 && p >= 0 && c + p == fee);
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn credit_rejects_overflow_and_non_positive() {
        assert_eq!(credit(i128::MAX, 1), None);
        assert_eq!(credit(10, 0), None);
        assert_eq!(credit(-1, 5), None);
        assert_eq!(credit(10, 5), Some(15));
    }

    #[test]
    fn debit_never_goes_negative() {
        assert_eq!(debit(5, 6), None);
        assert_eq!(debit(5, 5), Some(0));
        assert_eq!(debit(5, -1), None);
    }

    #[test]
    fn bps_share_is_bounded() {
        assert_eq!(bps_share(1_000, 10_001), None);
        assert_eq!(bps_share(i128::MAX, 10_000), None);
        assert_eq!(bps_share(1_000, 2_500), Some(250));
    }

    #[test]
    fn units_overflow_detected() {
        assert_eq!(add_units(u64::MAX, 1), None);
    }

    #[test]
    fn fee_split_conserves_value() {
        for fee in [0i128, 1, 7, 9_999, 10_000, 123_456_789] {
            let (c, p) = crate::algo_market::split_fee(fee);
            assert_eq!(c + p, fee);
            assert!(c >= 0 && p >= 0);
        }
    }
}
