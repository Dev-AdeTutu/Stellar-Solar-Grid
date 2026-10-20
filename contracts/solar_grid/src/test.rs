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
}
#[cfg(test)]
mod batch_and_market_tests {
    use super::*;
    use soroban_sdk::{testutils::Address as _, token, vec, Address, Env, String};

    fn setup() -> (Env, SolarGridContractClient<'static>, Address, Address) {
        let env = Env::default();
        env.mock_all_auths();
        let id = env.register_contract(None, SolarGridContract);
        let client = SolarGridContractClient::new(&env, &id);
        let admin = Address::generate(&env);
        let token = env
            .register_stellar_asset_contract_v2(Address::generate(&env))
            .address();
        client.initialize(&admin, &token);
        (env, client, admin, token)
    }

    #[test]
    fn batch_executes_all_actions() {
        let (env, client, _, _) = setup();
        let (a, b, oracle) = (Address::generate(&env), Address::generate(&env), Address::generate(&env));
        let actions = vec![
            &env,
            AdminAction::AllowlistAdd(a.clone()),
            AdminAction::AllowlistAdd(b.clone()),
            AdminAction::SetOracle(oracle.clone()),
        ];
        assert_eq!(client.execute_batch(&actions), 3);
        assert_eq!(client.get_allowlist().len(), 2);
        assert_eq!(client.get_oracle(), Some(oracle));
    }

    #[test]
    fn batch_is_atomic() {
        let (env, client, _, _) = setup();
        let a = Address::generate(&env);
        let actions = vec![
            &env,
            AdminAction::AllowlistAdd(a),
            AdminAction::SetDailyLimit(String::from_str(&env, "missing"), 10),
        ];
        assert!(client.try_execute_batch(&actions).is_err());
        assert_eq!(client.get_allowlist().len(), 0);
    }

    #[test]
    fn batch_rejects_empty_and_oversized() {
        let (env, client, _, _) = setup();
        assert_eq!(
            client.try_execute_batch(&Vec::new(&env)),
            Err(Ok(ContractError::BatchEmpty))
        );
        let mut big = Vec::new(&env);
        for _ in 0..=MAX_BATCH_ACTIONS {
            big.push_back(AdminAction::AllowlistAdd(Address::generate(&env)));
        }
        assert_eq!(client.try_execute_batch(&big), Err(Ok(ContractError::BatchTooLarge)));
    }

    #[test]
    fn marketplace_subscribe_shares_revenue_and_tracks_trades() {
        let (env, client, admin, token) = setup();
        let creator = Address::generate(&env);
        let user = Address::generate(&env);
        token::StellarAssetClient::new(&env, &token).mint(&user, &1_000);

        let id = client.publish_algorithm(&creator, &String::from_str(&env, "peak-shaver"), &1_000);
        client.subscribe_algorithm(&user, &id);

        let tc = token::Client::new(&env, &token);
        assert_eq!(tc.balance(&creator), 900);
        assert_eq!(tc.balance(&admin), 100);
        assert!(client.is_subscribed(&user, &id));
        assert_eq!(
            client.try_subscribe_algorithm(&user, &id),
            Err(Ok(ContractError::AlreadySubscribed))
        );

        client.set_oracle(&Address::generate(&env));
        client.record_algo_trade(&id, &250);
        client.record_algo_trade(&id, &-50);
        let algo = client.get_algorithm(&id);
        assert_eq!((algo.trades, algo.total_pnl, algo.subscribers), (2, 200, 1));
        assert_eq!(algo.creator_earnings, 900);

        client.unsubscribe_algorithm(&user, &id);
        assert_eq!(client.get_algorithm(&id).subscribers, 0);
        assert_eq!(client.list_algorithms().len(), 1);
    }

    #[test]
    fn inactive_algorithm_rejects_subscribers() {
        let (env, client, _, _) = setup();
        let creator = Address::generate(&env);
        let id = client.publish_algorithm(&creator, &String::from_str(&env, "x"), &0);
        client.set_algorithm_active(&id, &false);
        assert_eq!(
            client.try_subscribe_algorithm(&Address::generate(&env), &id),
            Err(Ok(ContractError::AlgorithmInactive))
        );
    }
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
    // Reputation / credit scoring tests
    // ------------------------------------------------------------------

    fn setup_reputation_meter(
        env: &Env,
        client: &SolarGridContractClient<'static>,
        token_address: &Address,
        owner: &Address,
    ) -> String {
        let meter_id = String::from_str(env, "SG-2024-REPMTR");
        let token_admin_client = token::StellarAssetClient::new(env, token_address);
        client.allowlist_add(owner);
        client.register_meter(&meter_id, owner);
        token_admin_client.mint(owner, &100_000_000_i128);
        meter_id
    }

    #[test]
    fn test_reputation_records_payment_history() {
        let (env, client, _admin, token_address) = setup_with_token();
        let owner = Address::generate(&env);
        let meter_id = setup_reputation_meter(&env, &client, &token_address, &owner);

        client.make_payment(&meter_id, &owner, &1_000_000_i128, &PaymentPlan::Daily);
        client.make_payment(&meter_id, &owner, &2_000_000_i128, &PaymentPlan::Daily);

        let history = client.get_payment_history(&owner);
        assert_eq!(history.len(), 2);
        // Raw per-payment amounts must not be exposed; only aggregates.
        let record = client.get_reputation(&owner);
        assert_eq!(record.payment_count, 2);
        assert!(record.total_paid > 0);
        assert!(record.score <= 100);
    }

    #[test]
    fn test_reputation_score_bounds() {
        let (env, client, _admin, token_address) = setup_with_token();
        let owner = Address::generate(&env);
        let meter_id = setup_reputation_meter(&env, &client, &token_address, &owner);

        // No history -> minimum score.
        let empty = client.get_reputation(&owner);
        assert_eq!(empty.score, 0);

        // Many on-time payments -> score capped at 100.
        for _ in 0..50 {
            client.make_payment(&meter_id, &owner, &1_000_000_i128, &PaymentPlan::Daily);
        }
        let full = client.get_reputation(&owner);
        assert_eq!(full.score, 100);
    }

    #[test]
    fn test_reputation_did_association() {
        let (env, client, _admin, token_address) = setup_with_token();
        let owner = Address::generate(&env);
        let meter_id = setup_reputation_meter(&env, &client, &token_address, &owner);
        client.make_payment(&meter_id, &owner, &1_000_000_i128, &PaymentPlan::Daily);

        let did = String::from_str(&env, "did:stellar:GABC123");
        client.set_did(&owner, &did);

        let record = client.get_reputation(&owner);
        assert_eq!(record.did, Some(did.clone()));
        assert_eq!(client.get_reputation_by_did(&did).unwrap().score, record.score);
    }

    #[test]
    fn test_reputation_portable_by_address() {
        let (env, client, _admin, token_address) = setup_with_token();
        let owner = Address::generate(&env);
        let meter_id = setup_reputation_meter(&env, &client, &token_address, &owner);
        client.make_payment(&meter_id, &owner, &1_000_000_i128, &PaymentPlan::Daily);

        // Score is queryable by address independent of any meter binding.
        let by_addr = client.get_reputation(&owner);
        assert!(by_addr.score > 0);
        assert_eq!(by_addr.payment_count, 1);
    }

    #[test]
    fn test_reputation_privacy_no_raw_amounts() {
        let (env, client, _admin, token_address) = setup_with_token();
        let owner = Address::generate(&env);
        let meter_id = setup_reputation_meter(&env, &client, &token_address, &owner);
        client.make_payment(&meter_id, &owner, &1_234_567_i128, &PaymentPlan::Daily);

        let record = client.get_reputation(&owner);
        // Aggregate only: total_paid is a sum, not the individual amount.
        assert_eq!(record.payment_count, 1);
        assert!(record.total_paid >= 1_234_567_i128);
        // History entries expose timestamps/status but not raw amounts.
        let history = client.get_payment_history(&owner);
        assert_eq!(history.len(), 1);
    }

    // ------------------------------------------------------------------
    // Carbon credit marketplace tests
    // ------------------------------------------------------------------

    fn setup_carbon_meter(
        env: &Env,
        client: &SolarGridContractClient<'static>,
        token_address: &Address,
        owner: &Address,
    ) -> String {
        let meter_id = String::from_str(env, "SG-2024-CARBON");
        let token_admin_client = token::StellarAssetClient::new(env, token_address);
        client.allowlist_add(owner);
        client.register_meter(&meter_id, owner);
        token_admin_client.mint(owner, &100_000_000_i128);
        client.make_payment(meter_id, owner, &10_000_000_i128, &PaymentPlan::Daily);
        meter_id
    }

    #[test]
    fn test_carbon_issuance_from_generation() {
        let (env, client, _admin, token_address) = setup_with_token();
        let owner = Address::generate(&env);
        let meter_id = setup_carbon_meter(&env, &client, &token_address, &owner);

        // Generation is recorded by the oracle and converted into credits.
        client.update_usage(&meter_id, &1_000_i128);
        let issued = client.issue_carbon_credits(&meter_id, &1_000_i128);
        assert!(issued > 0);

        let credits = client.get_carbon_credits(&owner);
        assert_eq!(credits, issued);
        assert_eq!(client.get_carbon_supply(), issued);
    }

    #[test]
    fn test_carbon_issuance_requires_verified_meter() {
        let (env, client, _admin, token_address) = setup_with_token();
        let owner = Address::generate(&env);
        let meter_id = setup_carbon_meter(&env, &client, &token_address, &owner);

        // Unverified meters cannot mint credits.
        let result = client.try_issue_carbon_credits(&meter_id, &1_000_i128);
        assert_eq!(result, Err(Ok(Error::CarbonNotVerified)));

        client.verify_carbon_meter(&meter_id);
        assert!(client.is_carbon_verified(&meter_id));
        assert!(client.issue_carbon_credits(&meter_id, &1_000_i128) > 0);
    }

    #[test]
    fn test_carbon_verification_admin_only() {
        let (env, client, _admin, token_address) = setup_with_token();
        let owner = Address::generate(&env);
        let meter_id = setup_carbon_meter(&env, &client, &token_address, &owner);

        let attacker = Address::generate(&env);
        let result = client.try_verify_carbon_meter(&attacker, &meter_id);
        assert_eq!(result, Err(Ok(Error::Unauthorized)));
    }

    #[test]
    fn test_carbon_list_and_buy_settles_trade() {
        let (env, client, _admin, token_address) = setup_with_token();
        let seller = Address::generate(&env);
        let buyer = Address::generate(&env);
        let meter_id = setup_carbon_meter(&env, &client, &token_address, &seller);
        client.verify_carbon_meter(&meter_id);
        let issued = client.issue_carbon_credits(&meter_id, &1_000_i128);

        let listing_id = client.list_carbon_credits(&seller, &issued, &100_i128);
        let listing = client.get_carbon_listing(&listing_id).unwrap();
        assert_eq!(listing.seller, seller);
        assert_eq!(listing.amount, issued);
        assert_eq!(listing.price, 100_i128);

        let token_admin_client = token::StellarAssetClient::new(&env, &token_address);
        token_admin_client.mint(&buyer, &1_000_000_i128);
        client.buy_carbon_credits(&buyer, &listing_id);

        let tc = token::Client::new(&env, &token_address);
        assert_eq!(tc.balance(&seller), 100_i128 * issued);
        assert_eq!(client.get_carbon_credits(&buyer), issued);
        assert_eq!(client.get_carbon_credits(&seller), 0);
        assert!(client.get_carbon_listing(&listing_id).is_none());
    }

    #[test]
    fn test_carbon_bid_and_fill_updates_index_price() {
        let (env, client, _admin, token_address) = setup_with_token();
        let seller = Address::generate(&env);
        let bidder = Address::generate(&env);
        let meter_id = setup_carbon_meter(&env, &client, &token_address, &seller);
        client.verify_carbon_meter(&meter_id);
        let issued = client.issue_carbon_credits(&meter_id, &1_000_i128);

        let listing_id = client.list_carbon_credits(&seller, &issued, &100_i128);
        let token_admin_client = token::StellarAssetClient::new(&env, &token_address);
        token_admin_client.mint(&bidder, &1_000_000_i128);

        // A bid above the ask is accepted and settles at the ask price.
        client.place_carbon_bid(&bidder, &listing_id, &issued, &150_i128);
        let bids = client.get_carbon_bids(&listing_id);
        assert_eq!(bids.len(), 1);

        client.fill_carbon_bid(&seller, &listing_id, &0);
        assert_eq!(client.get_carbon_credits(&bidder), issued);
        assert_eq!(client.get_carbon_index_price(), 100_i128);
    }

    #[test]
    fn test_carbon_cancel_listing_returns_credits() {
        let (env, client, _admin, token_address) = setup_with_token();
        let seller = Address::generate(&env);
        let meter_id = setup_carbon_meter(&env, &client, &token_address, &seller);
        client.verify_carbon_meter(&meter_id);
        let issued = client.issue_carbon_credits(&meter_id, &1_000_i128);

        let listing_id = client.list_carbon_credits(&seller, &issued, &100_i128);
        assert_eq!(client.get_carbon_credits(&seller), 0);

        client.cancel_carbon_listing(&seller, &listing_id);
        assert_eq!(client.get_carbon_credits(&seller), issued);
        assert!(client.get_carbon_listing(&listing_id).is_none());
    }

    #[test]
    fn test_carbon_cancel_listing_non_seller_rejected() {
        let (env, client, _admin, token_address) = setup_with_token();
        let seller = Address::generate(&env);
        let meter_id = setup_carbon_meter(&env, &client, &token_address, &seller);
        client.verify_carbon_meter(&meter_id);
        let issued = client.issue_carbon_credits(&meter_id, &1_000_i128);
        let listing_id = client.list_carbon_credits(&seller, &issued, &100_i128);

        let attacker = Address::generate(&env);
        let result = client.try_cancel_carbon_listing(&attacker, &listing_id);
        assert_eq!(result, Err(Ok(Error::Unauthorized)));
    }

    #[test]
    fn test_carbon_listing_requires_balance() {
        let (env, client, _admin, _token_address) = setup_with_token();
        let seller = Address::generate(&env);
        let result = client.try_list_carbon_credits(&seller, &1_000_i128, &100_i128);
        assert_eq!(result, Err(Ok(Error::InsufficientCarbonCredits)));
    }
}
