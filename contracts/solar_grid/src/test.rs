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
