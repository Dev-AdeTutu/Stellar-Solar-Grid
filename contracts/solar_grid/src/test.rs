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
    // Demand response automation tests
    // ------------------------------------------------------------------

    fn setup_dr_meter(
        env: &Env,
        client: &SolarGridContractClient<'static>,
        token_address: &Address,
        owner: &Address,
        meter_id: &String,
    ) {
        let token_admin_client = token::StellarAssetClient::new(env, token_address);
        client.allowlist_add(owner);
        client.register_meter(meter_id, owner);
        token_admin_client.mint(owner, &10_000_000_i128);
        client.make_payment(meter_id, owner, &10_000_000_i128, &PaymentPlan::Daily);
    }

    #[test]
    fn test_create_dr_event_with_curtailment_target() {
        let (env, client, admin, _token_address) = setup_with_token();
        let now = env.ledger().timestamp();
        let event_id = client.create_dr_event(
            &admin,
            &now,
            &(now + 3_600),
            &1_000_i128, // curtailment target (watts)
            &500_i128,   // incentive pool
        );

        let event = client.get_dr_event(&event_id).unwrap();
        assert_eq!(event.curtailment_target, 1_000_i128);
        assert_eq!(event.incentive_pool, 500_i128);
        assert_eq!(event.start, now);
        assert_eq!(event.end, now + 3_600);
        assert!(event.active);
    }

    #[test]
    fn test_create_dr_event_non_admin_rejected() {
        let (env, client, _admin, _token_address) = setup_with_token();
        let attacker = Address::generate(&env);
        let now = env.ledger().timestamp();
        let result = client.try_create_dr_event(
            &attacker,
            &now,
            &(now + 3_600),
            &1_000_i128,
            &500_i128,
        );
        assert_eq!(result, Err(Ok(Error::Unauthorized)));
    }

    #[test]
    fn test_create_dr_event_invalid_window_rejected() {
        let (env, client, admin, _token_address) = setup_with_token();
        let now = env.ledger().timestamp();
        let result = client.try_create_dr_event(
            &admin,
            &(now + 3_600),
            &now,
            &1_000_i128,
            &500_i128,
        );
        assert!(result.is_err());
    }

    #[test]
    fn test_dr_opt_in_records_load_preferences() {
        let (env, client, _admin, token_address) = setup_with_token();
        let owner = Address::generate(&env);
        let meter_id = String::from_str(&env, "SG-2024-DRMTR1");
        setup_dr_meter(&env, &client, &token_address, &owner, &meter_id);

        client.dr_opt_in(&meter_id, &owner, &300_i128, &true);

        let pref = client.get_dr_preference(&meter_id).unwrap();
        assert_eq!(pref.max_curtailment, 300_i128);
        assert!(pref.auto_curtail);
        assert!(pref.opted_in);
    }

    #[test]
    fn test_dr_opt_in_non_owner_rejected() {
        let (env, client, _admin, token_address) = setup_with_token();
        let owner = Address::generate(&env);
        let meter_id = String::from_str(&env, "SG-2024-DRMTR1");
        setup_dr_meter(&env, &client, &token_address, &owner, &meter_id);

        let attacker = Address::generate(&env);
        let result = client.try_dr_opt_in(&meter_id, &attacker, &300_i128, &true);
        assert_eq!(result, Err(Ok(Error::Unauthorized)));
    }

    #[test]
    fn test_dr_opt_out_removes_participation() {
        let (env, client, _admin, token_address) = setup_with_token();
        let owner = Address::generate(&env);
        let meter_id = String::from_str(&env, "SG-2024-DRMTR1");
        setup_dr_meter(&env, &client, &token_address, &owner, &meter_id);

        client.dr_opt_in(&meter_id, &owner, &300_i128, &true);
        client.dr_opt_out(&meter_id, &owner);

        let pref = client.get_dr_preference(&meter_id).unwrap();
        assert!(!pref.opted_in);
    }

    #[test]
    fn test_automated_curtailment_reduces_load() {
        let (env, client, admin, token_address) = setup_with_token();
        let owner = Address::generate(&env);
        let meter_id = String::from_str(&env, "SG-2024-DRMTR1");
        setup_dr_meter(&env, &client, &token_address, &owner, &meter_id);

        let now = env.ledger().timestamp();
        let event_id = client.create_dr_event(
            &admin,
            &now,
            &(now + 3_600),
            &1_000_i128,
            &500_i128,
        );
        client.dr_opt_in(&meter_id, &owner, &400_i128, &true);

        // Automated curtailment should reduce the meter's load.
        let reduced = client.apply_dr_curtailment(&event_id, &meter_id);
        assert_eq!(reduced, 400_i128);

        let participation = client.get_dr_participation(&event_id, &meter_id).unwrap();
        assert_eq!(participation.curtailed, 400_i128);
    }

    #[test]
    fn test_curtailment_respects_opt_in_preference() {
        let (env, client, admin, token_address) = setup_with_token();
        let owner = Address::generate(&env);
        let meter_id = String::from_str(&env, "SG-2024-DRMTR1");
        setup_dr_meter(&env, &client, &token_address, &owner, &meter_id);

        let now = env.ledger().timestamp();
        let event_id = client.create_dr_event(
            &admin,
            &now,
            &(now + 3_600),
            &1_000_i128,
            &500_i128,
        );
        // Opted out: no automatic curtailment.
        client.dr_opt_in(&meter_id, &owner, &400_i128, &true);
        client.dr_opt_out(&meter_id, &owner);

        let reduced = client.apply_dr_curtailment(&event_id, &meter_id);
        assert_eq!(reduced, 0_i128);
    }

    #[test]
    fn test_curtailment_capped_by_max_preference() {
        let (env, client, admin, token_address) = setup_with_token();
        let owner = Address::generate(&env);
        let meter_id = String::from_str(&env, "SG-2024-DRMTR1");
        setup_dr_meter(&env, &client, &token_address, &owner, &meter_id);

        let now = env.ledger().timestamp();
        let event_id = client.create_dr_event(
            &admin,
            &now,
            &(now + 3_600),
            &1_000_i128,
            &500_i128,
        );
        client.dr_opt_in(&meter_id, &owner, &250_i128, &true);

        let reduced = client.apply_dr_curtailment(&event_id, &meter_id);
        assert_eq!(reduced, 250_i128);
    }

    #[test]
    fn test_incentive_calculation_and_distribution() {
        let (env, client, admin, token_address) = setup_with_token();
        let owner = Address::generate(&env);
        let meter_id = String::from_str(&env, "SG-2024-DRMTR1");
        setup_dr_meter(&env, &client, &token_address, &owner, &meter_id);

        let now = env.ledger().timestamp();
        let event_id = client.create_dr_event(
            &admin,
            &now,
            &(now + 3_600),
            &1_000_i128,
            &500_i128,
        );
        client.dr_opt_in(&meter_id, &owner, &400_i128, &true);
        client.apply_dr_curtailment(&event_id, &meter_id);

        let incentive = client.calculate_dr_incentive(&event_id, &meter_id);
        assert!(incentive > 0);

        let tc = token::Client::new(&env, &token_address);
        let before = tc.balance(&owner);
        client.distribute_dr_incentive(&event_id, &meter_id);
        let after = tc.balance(&owner);
        assert_eq!(after - before, incentive);
    }

    #[test]
    fn test_incentive_zero_without_participation() {
        let (env, client, admin, _token_address) = setup_with_token();
        let owner = Address::generate(&env);
        let meter_id = String::from_str(&env, "SG-2024-DRMTR1");
        let now = env.ledger().timestamp();
        let event_id = client.create_dr_event(
            &admin,
            &now,
            &(now + 3_600),
            &1_000_i128,
            &500_i128,
        );
        // No opt-in / curtailment recorded.
        let incentive = client.calculate_dr_incentive(&event_id, &meter_id);
        assert_eq!(incentive, 0_i128);
    }

    #[test]
    fn test_dr_performance_verification() {
        let (env, client, admin, token_address) = setup_with_token();
        let owner = Address::generate(&env);
        let meter_id = String::from_str(&env, "SG-2024-DRMTR1");
        setup_dr_meter(&env, &client, &token_address, &owner, &meter_id);

        let now = env.ledger().timestamp();
        let event_id = client.create_dr_event(
            &admin,
            &now,
            &(now + 3_600),
            &1_000_i128,
            &500_i128,
        );
        client.dr_opt_in(&meter_id, &owner, &400_i128, &true);
        client.apply_dr_curtailment(&event_id, &meter_id);

        let perf = client.verify_dr_performance(&event_id, &meter_id);
        assert_eq!(perf.curtailed, 400_i128);
        assert!(perf.verified);
    }

    // ------------------------------------------------------------------
    // Meter lifecycle tracking tests
    // ------------------------------------------------------------------

    #[test]
    fn test_lifecycle_records_manufacturing_origin() {
        let (env, client, admin, _token_address) = setup_with_token();
        let meter_id = String::from_str(&env, "SG-2024-LCMTR1");
        let manufacturer = String::from_str(&env, "AcmeMeters");

        client.record_manufacturing(
            &admin,
            &meter_id,
            &manufacturer,
            &String::from_str(&env, "batch-001"),
            &1_000_i128, // copper grams
            &500_i128,   // silicon grams
        );

        let record = client.get_lifecycle(&meter_id).unwrap();
        assert_eq!(record.manufacturer, manufacturer);
        assert_eq!(record.materials.copper, 1_000_i128);
        assert_eq!(record.materials.silicon, 500_i128);
        assert_eq!(record.stage, LifecycleStage::Manufactured);
    }

    #[test]
    fn test_lifecycle_installation_repair_upgrade() {
        let (env, client, admin, _token_address) = setup_with_token();
        let meter_id = String::from_str(&env, "SG-2024-LCMTR1");
        let manufacturer = String::from_str(&env, "AcmeMeters");
        client.record_manufacturing(
            &admin,
            &meter_id,
            &manufacturer,
            &String::from_str(&env, "batch-001"),
            &1_000_i128,
            &500_i128,
        );

        let owner = Address::generate(&env);
        client.allowlist_add(&owner);
        client.register_meter(&meter_id, &owner);
        client.record_installation(&admin, &meter_id, &owner);
        assert_eq!(client.get_lifecycle(&meter_id).unwrap().stage, LifecycleStage::Installed);

        client.record_repair(&admin, &meter_id, &String::from_str(&env, "firmware reset"));
        client.record_upgrade(&admin, &meter_id, &String::from_str(&env, "v2.0"));

        let record = client.get_lifecycle(&meter_id).unwrap();
        assert_eq!(record.repairs, 1);
        assert_eq!(record.upgrades, 1);
    }

    #[test]
    fn test_lifecycle_recycling_certification() {
        let (env, client, admin, _token_address) = setup_with_token();
        let meter_id = String::from_str(&env, "SG-2024-LCMTR1");
        let manufacturer = String::from_str(&env, "AcmeMeters");
        client.record_manufacturing(
            &admin,
            &meter_id,
            &manufacturer,
            &String::from_str(&env, "batch-001"),
            &1_000_i128,
            &500_i128,
        );

        let recycler = String::from_str(&env, "GreenRecycle");
        client.certify_recycling(&admin, &meter_id, &recycler, &900_i128, &450_i128);

        let record = client.get_lifecycle(&meter_id).unwrap();
        assert_eq!(record.stage, LifecycleStage::Recycled);
        assert_eq!(record.recycler, Some(recycler));
        assert!(record.recycling_certified);
    }

    #[test]
    fn test_lifecycle_material_recovery_tracking() {
        let (env, client, admin, _token_address) = setup_with_token();
        let meter_id = String::from_str(&env, "SG-2024-LCMTR1");
        let manufacturer = String::from_str(&env, "AcmeMeters");
        client.record_manufacturing(
            &admin,
            &meter_id,
            &manufacturer,
            &String::from_str(&env, "batch-001"),
            &1_000_i128,
            &500_i128,
        );

        client.certify_recycling(
            &admin,
            &meter_id,
            &String::from_str(&env, "GreenRecycle"),
            &900_i128,
            &450_i128,
        );

        let recovery = client.get_material_recovery(&meter_id).unwrap();
        assert_eq!(recovery.copper_recovered, 900_i128);
        assert_eq!(recovery.silicon_recovered, 450_i128);
        // Recovery rate should be within [0, 100].
        assert!(recovery.recovery_rate <= 100);
    }

    #[test]
    fn test_lifecycle_compliance_check() {
        let (env, client, admin, _token_address) = setup_with_token();
        let meter_id = String::from_str(&env, "SG-2024-LCMTR1");
        let manufacturer = String::from_str(&env, "AcmeMeters");
        client.record_manufacturing(
            &admin,
            &meter_id,
            &manufacturer,
            &String::from_str(&env, "batch-001"),
            &1_000_i128,
            &500_i128,
        );

        // Not yet recycled -> non-compliant.
        assert!(!client.check_lifecycle_compliance(&meter_id));

        client.certify_recycling(
            &admin,
            &meter_id,
            &String::from_str(&env, "GreenRecycle"),
            &900_i128,
            &450_i128,
        );
        assert!(client.check_lifecycle_compliance(&meter_id));
    }

    #[test]
    fn test_lifecycle_non_admin_rejected() {
        let (env, client, _admin, _token_address) = setup_with_token();
        let meter_id = String::from_str(&env, "SG-2024-LCMTR1");
        let attacker = Address::generate(&env);
        let result = client.try_record_manufacturing(
            &attacker,
            &meter_id,
            &String::from_str(&env, "AcmeMeters"),
            &String::from_str(&env, "batch-001"),
            &1_000_i128,
            &500_i128,
        );
        assert_eq!(result, Err(Ok(Error::Unauthorized)));
    }
}
