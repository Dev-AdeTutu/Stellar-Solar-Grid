#[cfg(test)]
mod additional_tests {
    use super::*;
    use soroban_sdk::{
        symbol_short,
        testutils::{Address as _, Events, Ledger},
        token, Address, Env, Symbol, TryFromVal,
    };

    fn setup() -> (Env, SolarGridContractClient<'static>, Address) {
        let env = Env::default();
        env.mock_all_auths();
        let contract_id = env.register_contract(None, SolarGridContract);
        let client = SolarGridContractClient::new(&env, &contract_id);
        let admin = Address::generate(&env);
        (env, client, admin)
    }

    fn setup_with_token() -> (Env, SolarGridContractClient<'static>, Address, Address) {
        let env = Env::default();
        env.mock_all_auths();
        let contract_id = env.register_contract(None, SolarGridContract);
        let client = SolarGridContractClient::new(&env, &contract_id);
        let admin = Address::generate(&env);
        let token_admin = Address::generate(&env);
        let token_address = env
            .register_stellar_asset_contract_v2(token_admin)
            .address();
        client.initialize(&admin, &token_address);
        (env, client, admin, token_address)
    }

    #[test]
    fn test_register_and_payment() {
        let (env, client, admin) = setup();
        let meter_id = String::from_str(&env, "SG-2024-METER1");
        let owner = Address::generate(&env);
        
        // Initialize contract first
        let token_admin = Address::generate(&env);
        let token_address = env
            .register_stellar_asset_contract_v2(token_admin)
            .address();
        client.initialize(&admin, &token_address);
        
        // Register meter
        client.allowlist_add(&owner);
        client.register_meter(&meter_id, &owner);
        
        // Verify meter exists and is inactive
        let meter = client.get_meter(&meter_id).unwrap();
        assert!(!meter.active);
        assert_eq!(meter.owner, owner);
    }

    #[test]
    fn test_double_register_fails() {
        let (env, client, admin) = setup();
        let meter_id = String::from_str(&env, "SG-2024-METER1");
        let owner = Address::generate(&env);
        
        // Initialize contract
        let token_admin = Address::generate(&env);
        let token_address = env
            .register_stellar_asset_contract_v2(token_admin)
            .address();
        client.initialize(&admin, &token_address);
        
        // Register meter once
        client.allowlist_add(&owner);
        client.register_meter(&meter_id, &owner);
        
        // Try to register again - should fail
        let result = std::panic::catch_unwind(|| {
            client.register_meter(&meter_id, &owner);
        });
        assert!(result.is_err());
    }

    #[test]
    fn test_payment_on_inactive_meter() {
        let (env, client, admin, token_address) = setup_with_token();
        let token_admin_client = token::StellarAssetClient::new(&env, &token_address);
        let meter_id = String::from_str(&env, "SG-2024-METER1");
        let owner = Address::generate(&env);
        
        // Register meter but don't activate
        client.allowlist_add(&owner);
        client.register_meter(&meter_id, &owner);
        
        // Try to make payment - should work but meter should become active
        token_admin_client.mint(&owner, &1_000_000_i128);
        client.make_payment(&meter_id, &owner, &1_000_000_i128, &PaymentPlan::Daily);
        
        // Verify meter is now active
        assert!(client.check_access(&meter_id));
    }

    #[test]
    fn test_zero_balance_access() {
        let (env, client, admin, token_address) = setup_with_token();
        let meter_id = String::from_str(&env, "SG-2024-METER1");
        let owner = Address::generate(&env);
        
        // Register meter
        client.allowlist_add(&owner);
        client.register_meter(&meter_id, &owner);
        
        // Check access with zero balance - should be false
        assert!(!client.check_access(&meter_id));
    }

    #[test]
    fn test_usage_update_edge_cases() {
        let (env, client, admin, token_address) = setup_with_token();
        let token_admin_client = token::StellarAssetClient::new(&env, &token_address);
        let oracle = Address::generate(&env);
        client.set_oracle(&oracle);
        
        let meter_id = String::from_str(&env, "SG-2024-METER1");
        let owner = Address::generate(&env);
        
        // Setup meter with payment
        client.allowlist_add(&owner);
        client.register_meter(&meter_id, &owner);
        token_admin_client.mint(&owner, &5_000_000_i128);
        client.make_payment(&meter_id, &owner, &5_000_000_i128, &PaymentPlan::Daily);
        
        // Test large usage update
        env.mock_all_auths_allowing_non_root_auth();
        client.update_usage(&meter_id, &4_999_999_i128);
        
        // Verify balance is nearly depleted
        let meter = client.get_meter(&meter_id).unwrap();
        assert!(meter.balance < 10_i128);
    }

    // ------------------------------------------------------------------
    // Delegation tests
    // ------------------------------------------------------------------

    fn setup_meter_with_payment(
        env: &Env,
        client: &SolarGridContractClient<'static>,
        token_address: &Address,
        meter_id: &String,
        owner: &Address,
    ) {
        let token_admin_client = token::StellarAssetClient::new(env, token_address);
        client.allowlist_add(owner);
        client.register_meter(meter_id, owner);
        token_admin_client.mint(owner, &10_000_000_i128);
        client.make_payment(meter_id, owner, &10_000_000_i128, &PaymentPlan::Daily);
    }

    #[test]
    fn test_add_delegate_with_each_permission() {
        let (env, client, _admin, token_address) = setup_with_token();
        let meter_id = String::from_str(&env, "SG-2024-METER1");
        let owner = Address::generate(&env);
        setup_meter_with_payment(&env, &client, &token_address, &meter_id, &owner);

        let expiry = env.ledger().timestamp() + 86_400;
        let view_only = Address::generate(&env);
        let payer = Address::generate(&env);
        let admin_delegate = Address::generate(&env);

        client.add_delegate(&meter_id, &owner, &view_only, &Permission::ViewOnly, &expiry);
        client.add_delegate(&meter_id, &owner, &payer, &Permission::Pay, &expiry);
        client.add_delegate(&meter_id, &owner, &admin_delegate, &Permission::Admin, &expiry);

        let delegates = client.get_delegates(&meter_id);
        assert_eq!(delegates.len(), 3);

        let mut found_view = false;
        let mut found_pay = false;
        let mut found_admin = false;
        for d in delegates.iter() {
            assert_eq!(d.expiry, expiry);
            match d.permissions {
                Permission::ViewOnly => found_view = true,
                Permission::Pay => found_pay = true,
                Permission::Admin => found_admin = true,
            }
        }
        assert!(found_view && found_pay && found_admin);
    }

    #[test]
    fn test_non_owner_add_delegate_unauthorized() {
        let (env, client, _admin, token_address) = setup_with_token();
        let meter_id = String::from_str(&env, "SG-2024-METER1");
        let owner = Address::generate(&env);
        setup_meter_with_payment(&env, &client, &token_address, &meter_id, &owner);

        let attacker = Address::generate(&env);
        let delegate = Address::generate(&env);
        let expiry = env.ledger().timestamp() + 86_400;

        let result = client.try_add_delegate(
            &meter_id,
            &attacker,
            &delegate,
            &Permission::ViewOnly,
            &expiry,
        );
        assert_eq!(result, Err(Ok(Error::Unauthorized)));
    }

    #[test]
    fn test_add_delegate_zero_permissions_rejected() {
        let (env, client, _admin, token_address) = setup_with_token();
        let meter_id = String::from_str(&env, "SG-2024-METER1");
        let owner = Address::generate(&env);
        setup_meter_with_payment(&env, &client, &token_address, &meter_id, &owner);

        let delegate = Address::generate(&env);
        let expiry = env.ledger().timestamp() + 86_400;

        let result = client.try_add_delegate(
            &meter_id,
            &owner,
            &delegate,
            &Permission::None,
            &expiry,
        );
        assert!(result.is_err());
    }

    #[test]
    fn test_add_delegate_past_expiry_rejected() {
        let (env, client, _admin, token_address) = setup_with_token();
        let meter_id = String::from_str(&env, "SG-2024-METER1");
        let owner = Address::generate(&env);
        setup_meter_with_payment(&env, &client, &token_address, &meter_id, &owner);

        let delegate = Address::generate(&env);
        let past = env.ledger().timestamp().saturating_sub(1);

        let result = client.try_add_delegate(
            &meter_id,
            &owner,
            &delegate,
            &Permission::ViewOnly,
            &past,
        );
        assert!(result.is_err());
    }

    #[test]
    fn test_remove_delegate_removes_entry_and_emits_event() {
        let (env, client, _admin, token_address) = setup_with_token();
        let meter_id = String::from_str(&env, "SG-2024-METER1");
        let owner = Address::generate(&env);
        setup_meter_with_payment(&env, &client, &token_address, &meter_id, &owner);

        let delegate = Address::generate(&env);
        let expiry = env.ledger().timestamp() + 86_400;
        client.add_delegate(&meter_id, &owner, &delegate, &Permission::Pay, &expiry);
        assert_eq!(client.get_delegates(&meter_id).len(), 1);

        client.remove_delegate(&meter_id, &owner, &delegate);
        assert_eq!(client.get_delegates(&meter_id).len(), 0);

        let events = env.events().all();
        let removed_topic = (symbol_short!("deleg_rm"), meter_id.clone()).into_val(&env);
        let mut found = false;
        for (topics, _data) in events.iter() {
            if topics == removed_topic {
                found = true;
            }
        }
        assert!(found, "DelegateRemoved event not emitted");
    }

    #[test]
    fn test_expired_delegate_rejected_by_make_delegated_payment() {
        let (env, client, _admin, token_address) = setup_with_token();
        let meter_id = String::from_str(&env, "SG-2024-METER1");
        let owner = Address::generate(&env);
        setup_meter_with_payment(&env, &client, &token_address, &meter_id, &owner);

        let delegate = Address::generate(&env);
        let expiry = env.ledger().timestamp() + 100;
        client.add_delegate(&meter_id, &owner, &delegate, &Permission::Pay, &expiry);

        // Advance ledger past expiry
        env.ledger().set_timestamp(expiry + 1);

        let token_admin_client = token::StellarAssetClient::new(&env, &token_address);
        token_admin_client.mint(&delegate, &1_000_000_i128);

        let result = client.try_make_delegated_payment(
            &meter_id,
            &delegate,
            &1_000_000_i128,
            &PaymentPlan::Daily,
        );
        assert!(result.is_err());
    }

    #[test]
    fn test_delegate_without_pay_permission_rejected() {
        let (env, client, _admin, token_address) = setup_with_token();
        let meter_id = String::from_str(&env, "SG-2024-METER1");
        let owner = Address::generate(&env);
        setup_meter_with_payment(&env, &client, &token_address, &meter_id, &owner);

        let delegate = Address::generate(&env);
        let expiry = env.ledger().timestamp() + 86_400;
        client.add_delegate(&meter_id, &owner, &delegate, &Permission::ViewOnly, &expiry);

        let token_admin_client = token::StellarAssetClient::new(&env, &token_address);
        token_admin_client.mint(&delegate, &1_000_000_i128);

        let result = client.try_make_delegated_payment(
            &meter_id,
            &delegate,
            &1_000_000_i128,
            &PaymentPlan::Daily,
        );
        assert_eq!(result, Err(Ok(Error::Unauthorized)));
    }

    #[test]
    fn test_get_delegates_returns_full_structs() {
        let (env, client, _admin, token_address) = setup_with_token();
        let meter_id = String::from_str(&env, "SG-2024-METER1");
        let owner = Address::generate(&env);
        setup_meter_with_payment(&env, &client, &token_address, &meter_id, &owner);

        let delegate = Address::generate(&env);
        let expiry = env.ledger().timestamp() + 86_400;
        client.add_delegate(&meter_id, &owner, &delegate, &Permission::Admin, &expiry);

        let delegates = client.get_delegates(&meter_id);
        assert_eq!(delegates.len(), 1);
        let d = delegates.get(0).unwrap();
        assert_eq!(d.delegated_address, delegate);
        assert_eq!(d.permissions, Permission::Admin);
        assert_eq!(d.expiry, expiry);
    }

    #[test]
    fn test_delegate_added_event_topics() {
        let (env, client, _admin, token_address) = setup_with_token();
        let meter_id = String::from_str(&env, "SG-2024-METER1");
        let owner = Address::generate(&env);
        setup_meter_with_payment(&env, &client, &token_address, &meter_id, &owner);

        let delegate = Address::generate(&env);
        let expiry = env.ledger().timestamp() + 86_400;
        client.add_delegate(&meter_id, &owner, &delegate, &Permission::Pay, &expiry);

        let events = env.events().all();
        let added_topic = (symbol_short!("deleg_add"), meter_id.clone()).into_val(&env);
        let mut found = false;
        for (topics, _data) in events.iter() {
            if topics == added_topic {
                found = true;
            }
        }
        assert!(found, "DelegateAdded event not emitted");
    }

    // ------------------------------------------------------------------
    // Seasonal pricing tests
    // ------------------------------------------------------------------

    fn season_range(env: &Env, start: u64, end: u64, multiplier: u32) -> SeasonalRate {
        SeasonalRate {
            season: Season::Summer,
            start_date: start,
            end_date: end,
            multiplier,
        }
    }

    #[test]
    fn test_set_seasonal_rates_admin_only() {
        let (env, client, _admin, _token_address) = setup_with_token();
        let attacker = Address::generate(&env);
        let now = env.ledger().timestamp();
        let rates = soroban_sdk::vec![
            &env,
            season_range(&env, now, now + 1_000, 12_000),
        ];

        let result = client.try_set_seasonal_rates(&attacker, &rates);
        assert_eq!(result, Err(Ok(Error::Unauthorized)));
    }

    #[test]
    fn test_set_seasonal_rates_overlapping_rejected() {
        let (env, client, admin, _token_address) = setup_with_token();
        let now = env.ledger().timestamp();
        let rates = soroban_sdk::vec![
            &env,
            season_range(&env, now, now + 1_000, 12_000),
            season_range(&env, now + 500, now + 2_000, 11_000),
        ];

        let result = client.try_set_seasonal_rates(&admin, &rates);
        assert!(result.is_err());
    }

    #[test]
    fn test_set_seasonal_rates_descending_rejected() {
        let (env, client, admin, _token_address) = setup_with_token();
        let now = env.ledger().timestamp();
        let rates = soroban_sdk::vec![
            &env,
            season_range(&env, now + 2_000, now + 1_000, 12_000),
        ];

        let result = client.try_set_seasonal_rates(&admin, &rates);
        assert!(result.is_err());
    }

    #[test]
    fn test_get_current_season_matches_timestamp() {
        let (env, client, admin, _token_address) = setup_with_token();
        let now = env.ledger().timestamp();
        let rates = soroban_sdk::vec![
            &env,
            season_range(&env, now, now + 1_000, 12_000),
        ];
        client.set_seasonal_rates(&admin, &rates);

        env.ledger().set_timestamp(now + 500);
        let current = client.get_current_season();
        assert!(current.is_some());
        assert_eq!(current.unwrap().multiplier, 12_000);
    }

    #[test]
    fn test_compute_cost_applies_active_multiplier() {
        let (env, client, admin, _token_address) = setup_with_token();
        let now = env.ledger().timestamp();
        let rates = soroban_sdk::vec![
            &env,
            season_range(&env, now, now + 1_000, 20_000),
        ];
        client.set_seasonal_rates(&admin, &rates);
        env.ledger().set_timestamp(now + 100);

        let base = client.compute_cost(&1_000_i128);
        assert_eq!(base, 2_000_i128);
    }

    #[test]
    fn test_seasonal_rate_applied_event_emitted() {
        let (env, client, admin, _token_address) = setup_with_token();
        let now = env.ledger().timestamp();
        let rates = soroban_sdk::vec![
            &env,
            season_range(&env, now, now + 1_000, 15_000),
        ];
        client.set_seasonal_rates(&admin, &rates);

        let events = env.events().all();
        let applied_topic = symbol_short!("season_ap").into_val(&env);
        let mut found = false;
        for (topics, _data) in events.iter() {
            if topics == applied_topic {
                found = true;
            }
        }
        assert!(found, "SeasonalRateApplied event not emitted");
    }

    #[test]
    fn test_timestamp_outside_ranges_falls_back_to_base_rate() {
        let (env, client, admin, _token_address) = setup_with_token();
        let now = env.ledger().timestamp();
        let rates = soroban_sdk::vec![
            &env,
            season_range(&env, now + 10_000, now + 20_000, 20_000),
        ];
        client.set_seasonal_rates(&admin, &rates);

        env.ledger().set_timestamp(now);
        assert!(client.get_current_season().is_none());

        let base = client.compute_cost(&1_000_i128);
        assert_eq!(base, 1_000_i128);
    }

    // ------------------------------------------------------------------
    // Co-ownership tests
    // ------------------------------------------------------------------

    fn setup_co_owned_meter(
        env: &Env,
        client: &SolarGridContractClient<'static>,
        token_address: &Address,
        meter_id: &String,
        owner: &Address,
    ) {
        setup_meter_with_payment(env, client, token_address, meter_id, owner);
    }

    #[test]
    fn test_multiple_addresses_own_shares_of_single_meter() {
        let (env, client, _admin, token_address) = setup_with_token();
        let meter_id = String::from_str(&env, "SG-2024-CO1");
        let owner = Address::generate(&env);
        setup_co_owned_meter(&env, &client, &token_address, &meter_id, &owner);

        let co1 = Address::generate(&env);
        let co2 = Address::generate(&env);
        client.set_ownership_share(&meter_id, &owner, &co1, &3_000_u32);
        client.set_ownership_share(&meter_id, &owner, &co2, &2_000_u32);

        let shares = client.get_ownership_shares(&meter_id);
        assert_eq!(shares.len(), 2);
        assert_eq!(client.get_ownership_share(&meter_id, &co1), 3_000_u32);
        assert_eq!(client.get_ownership_share(&meter_id, &co2), 2_000_u32);
    }

    #[test]
    fn test_ownership_shares_cannot_exceed_total() {
        let (env, client, _admin, token_address) = setup_with_token();
        let meter_id = String::from_str(&env, "SG-2024-CO2");
        let owner = Address::generate(&env);
        setup_co_owned_meter(&env, &client, &token_address, &meter_id, &owner);

        let co1 = Address::generate(&env);
        let co2 = Address::generate(&env);
        client.set_ownership_share(&meter_id, &owner, &co1, &6_000_u32);

        // Adding another 6_000 would exceed 10_000 (100%) and must be rejected.
        let result = client.try_set_ownership_share(&meter_id, &owner, &co2, &6_000_u32);
        assert_eq!(result, Err(Ok(Error::InvalidShare)));
    }

    #[test]
    fn test_unauthorized_share_transfer_rejected() {
        let (env, client, _admin, token_address) = setup_with_token();
        let meter_id = String::from_str(&env, "SG-2024-CO3");
        let owner = Address::generate(&env);
        setup_co_owned_meter(&env, &client, &token_address, &meter_id, &owner);

        let co1 = Address::generate(&env);
        client.set_ownership_share(&meter_id, &owner, &co1, &2_000_u32);

        let attacker = Address::generate(&env);
        let recipient = Address::generate(&env);
        let result = client.try_transfer_ownership_share(
            &meter_id,
            &attacker,
            &co1,
            &recipient,
            &1_000_u32,
        );
        assert_eq!(result, Err(Ok(Error::Unauthorized)));
    }

    #[test]
    fn test_transfer_ownership_share_moves_balance() {
        let (env, client, _admin, token_address) = setup_with_token();
        let meter_id = String::from_str(&env, "SG-2024-CO4");
        let owner = Address::generate(&env);
        setup_co_owned_meter(&env, &client, &token_address, &meter_id, &owner);

        let co1 = Address::generate(&env);
        let co2 = Address::generate(&env);
        client.set_ownership_share(&meter_id, &owner, &co1, &4_000_u32);

        client.transfer_ownership_share(&meter_id, &co1, &co1, &co2, &1_500_u32);

        assert_eq!(client.get_ownership_share(&meter_id, &co1), 2_500_u32);
        assert_eq!(client.get_ownership_share(&meter_id, &co2), 1_500_u32);
    }

    #[test]
    fn test_transfer_more_than_owned_rejected() {
        let (env, client, _admin, token_address) = setup_with_token();
        let meter_id = String::from_str(&env, "SG-2024-CO5");
        let owner = Address::generate(&env);
        setup_co_owned_meter(&env, &client, &token_address, &meter_id, &owner);

        let co1 = Address::generate(&env);
        let co2 = Address::generate(&env);
        client.set_ownership_share(&meter_id, &owner, &co1, &1_000_u32);

        let result = client.try_transfer_ownership_share(
            &meter_id,
            &co1,
            &co1,
            &co2,
            &2_000_u32,
        );
        assert_eq!(result, Err(Ok(Error::InvalidShare)));
    }

    #[test]
    fn test_proportional_cost_sharing() {
        let (env, client, _admin, token_address) = setup_with_token();
        let meter_id = String::from_str(&env, "SG-2024-CO6");
        let owner = Address::generate(&env);
        setup_co_owned_meter(&env, &client, &token_address, &meter_id, &owner);

        let co1 = Address::generate(&env);
        let co2 = Address::generate(&env);
        client.set_ownership_share(&meter_id, &owner, &co1, &6_000_u32);
        client.set_ownership_share(&meter_id, &owner, &co2, &4_000_u32);

        // 10_000 total cost split 60/40.
        assert_eq!(client.compute_owner_cost(&meter_id, &co1, &10_000_i128), 6_000_i128);
        assert_eq!(client.compute_owner_cost(&meter_id, &co2, &10_000_i128), 4_000_i128);
    }

    #[test]
    fn test_proportional_revenue_sharing() {
        let (env, client, _admin, token_address) = setup_with_token();
        let meter_id = String::from_str(&env, "SG-2024-CO7");
        let owner = Address::generate(&env);
        setup_co_owned_meter(&env, &client, &token_address, &meter_id, &owner);

        let co1 = Address::generate(&env);
        let co2 = Address::generate(&env);
        client.set_ownership_share(&meter_id, &owner, &co1, &2_500_u32);
        client.set_ownership_share(&meter_id, &owner, &co2, &7_500_u32);

        // 10_000 total export revenue split 25/75.
        assert_eq!(client.compute_owner_revenue(&meter_id, &co1, &10_000_i128), 2_500_i128);
        assert_eq!(client.compute_owner_revenue(&meter_id, &co2, &10_000_i128), 7_500_i128);
    }

    #[test]
    fn test_voting_weight_matches_ownership_percentage() {
        let (env, client, _admin, token_address) = setup_with_token();
        let meter_id = String::from_str(&env, "SG-2024-CO8");
        let owner = Address::generate(&env);
        setup_co_owned_meter(&env, &client, &token_address, &meter_id, &owner);

        let co1 = Address::generate(&env);
        let co2 = Address::generate(&env);
        client.set_ownership_share(&meter_id, &owner, &co1, &3_000_u32);
        client.set_ownership_share(&meter_id, &owner, &co2, &7_000_u32);

        assert_eq!(client.get_voting_weight(&meter_id, &co1), 3_000_u32);
        assert_eq!(client.get_voting_weight(&meter_id, &co2), 7_000_u32);
    }

    // ------------------------------------------------------------------
    // Derivatives tests
    // ------------------------------------------------------------------

    fn setup_derivatives(
        env: &Env,
        client: &SolarGridContractClient<'static>,
        token_address: &Address,
        admin: &Address,
    ) {
        let token_admin_client = token::StellarAssetClient::new(env, token_address);
        let writer = Address::generate(env);
        token_admin_client.mint(writer, &100_000_000_i128);
        client.set_derivatives_writer(&admin, &writer);
    }

    #[test]
    fn test_create_future_and_settle_at_expiry() {
        let (env, client, admin, token_address) = setup_with_token();
        setup_derivatives(&env, &client, &token_address, &admin);

        let buyer = Address::generate(&env);
        let token_admin_client = token::StellarAssetClient::new(&env, &token_address);
        token_admin_client.mint(&buyer, &10_000_000_i128);

        let expiry = env.ledger().timestamp() + 1_000;
        let future_id = client.create_future(&buyer, &1_000_i128, &expiry, &1_000_000_i128);
        assert!(client.get_future(&future_id).is_some());

        // Settlement before expiry must fail.
        let early = client.try_settle_future(&future_id);
        assert!(early.is_err());

        env.ledger().set_timestamp(expiry + 1);
        client.settle_future(&future_id);

        let future = client.get_future(&future_id).unwrap();
        assert!(future.settled);
    }

    #[test]
    fn test_call_option_exercise() {
        let (env, client, admin, token_address) = setup_with_token();
        setup_derivatives(&env, &client, &token_address, &admin);

        let buyer = Address::generate(&env);
        let token_admin_client = token::StellarAssetClient::new(&env, &token_address);
        token_admin_client.mint(&buyer, &10_000_000_i128);

        let expiry = env.ledger().timestamp() + 1_000;
        let option_id = client.create_option(
            &buyer,
            &OptionType::Call,
            &1_000_i128,
            &expiry,
            &1_000_000_i128,
        );

        // Exercise before expiry succeeds.
        client.exercise_option(&option_id);
        let option = client.get_option(&option_id).unwrap();
        assert!(option.exercised);
    }

    #[test]
    fn test_put_option_exercise() {
        let (env, client, admin, token_address) = setup_with_token();
        setup_derivatives(&env, &client, &token_address, &admin);

        let buyer = Address::generate(&env);
        let token_admin_client = token::StellarAssetClient::new(&env, &token_address);
        token_admin_client.mint(&buyer, &10_000_000_i128);

        let expiry = env.ledger().timestamp() + 1_000;
        let option_id = client.create_option(
            &buyer,
            &OptionType::Put,
            &1_000_i128,
            &expiry,
            &1_000_000_i128,
        );

        client.exercise_option(&option_id);
        let option = client.get_option(&option_id).unwrap();
        assert!(option.exercised);
    }

    #[test]
    fn test_option_exercise_after_expiry_rejected() {
        let (env, client, admin, token_address) = setup_with_token();
        setup_derivatives(&env, &client, &token_address, &admin);

        let buyer = Address::generate(&env);
        let token_admin_client = token::StellarAssetClient::new(&env, &token_address);
        token_admin_client.mint(&buyer, &10_000_000_i128);

        let expiry = env.ledger().timestamp() + 1_000;
        let option_id = client.create_option(
            &buyer,
            &OptionType::Call,
            &1_000_i128,
            &expiry,
            &1_000_000_i128,
        );

        env.ledger().set_timestamp(expiry + 1);
        let result = client.try_exercise_option(&option_id);
        assert!(result.is_err());
    }

    #[test]
    fn test_margin_requirement_enforced_on_creation() {
        let (env, client, admin, token_address) = setup_with_token();
        setup_derivatives(&env, &client, &token_address, &admin);

        let buyer = Address::generate(&env);
        let token_admin_client = token::StellarAssetClient::new(&env, &token_address);
        // Fund below the required initial margin.
        token_admin_client.mint(&buyer, &100_i128);

        let expiry = env.ledger().timestamp() + 1_000;
        let result = client.try_create_future(&buyer, &1_000_i128, &expiry, &1_000_000_i128);
        assert_eq!(result, Err(Ok(Error::InsufficientMargin)));
    }

    #[test]
    fn test_liquidation_below_maintenance_margin() {
        let (env, client, admin, token_address) = setup_with_token();
        setup_derivatives(&env, &client, &token_address, &admin);

        let buyer = Address::generate(&env);
        let token_admin_client = token::StellarAssetClient::new(&env, &token_address);
        token_admin_client.mint(&buyer, &10_000_000_i128);

        let expiry = env.ledger().timestamp() + 1_000;
        let future_id = client.create_future(&buyer, &1_000_i128, &expiry, &1_000_000_i128);

        // Drop the position's margin below the maintenance threshold.
        client.set_future_margin(&future_id, &1_i128);
        assert!(client.is_under_maintenance_margin(&future_id));

        client.liquidate_future(&future_id);
        let future = client.get_future(&future_id).unwrap();
        assert!(future.liquidated);
    }

    #[test]
    fn test_liquidation_above_maintenance_rejected() {
        let (env, client, admin, token_address) = setup_with_token();
        setup_derivatives(&env, &client, &token_address, &admin);

        let buyer = Address::generate(&env);
        let token_admin_client = token::StellarAssetClient::new(&env, &token_address);
        token_admin_client.mint(&buyer, &10_000_000_i128);

        let expiry = env.ledger().timestamp() + 1_000;
        let future_id = client.create_future(&buyer, &1_000_i128, &expiry, &1_000_000_i128);

        let result = client.try_liquidate_future(&future_id);
        assert_eq!(result, Err(Ok(Error::NotLiquidatable)));
    }
}