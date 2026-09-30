//! Admin multisig proposals, pause/freeze controls, oracle and audit log
//! (Issue #874).
mod common;

use common::Fixture;
use solar_grid::{AdminOperation, AuditLogFilter, ContractError, PaymentPlan};
use soroban_sdk::{testutils::Address as _, vec, Address, String, Vec};

fn multisig(fx: &Fixture, threshold: u32) -> Vec<Address> {
    let admins = vec![
        &fx.env,
        Address::generate(&fx.env),
        Address::generate(&fx.env),
        Address::generate(&fx.env),
    ];
    fx.client.configure_multisig(&admins, &threshold);
    admins
}

#[test]
fn configure_multisig_validates_size_and_threshold() {
    let fx = Fixture::new();
    let two = vec![
        &fx.env,
        Address::generate(&fx.env),
        Address::generate(&fx.env),
    ];
    assert_eq!(
        fx.client.try_configure_multisig(&two, &1),
        Err(Ok(ContractError::InvalidMultisigConfiguration))
    );
    let three = vec![
        &fx.env,
        Address::generate(&fx.env),
        Address::generate(&fx.env),
        Address::generate(&fx.env),
    ];
    assert_eq!(
        fx.client.try_configure_multisig(&three, &0),
        Err(Ok(ContractError::InvalidMultisigConfiguration))
    );
    assert_eq!(
        fx.client.try_configure_multisig(&three, &4),
        Err(Ok(ContractError::InvalidMultisigConfiguration))
    );
    fx.client.configure_multisig(&three, &2);
    assert_eq!(fx.client.get_multisig_config(), (three, 2));
}

#[test]
fn proposal_requires_threshold_before_execution() {
    let fx = Fixture::new();
    fx.set_time(100);
    let admins = multisig(&fx, 2);
    let id =
        fx.client
            .propose_admin_operation(&admins.get(0).unwrap(), &AdminOperation::Pause, &1_000);

    assert_eq!(
        fx.client.try_execute_admin_operation(&id),
        Err(Ok(ContractError::ProposalNotReady))
    );
    assert_eq!(
        fx.client
            .try_approve_admin_operation(&id, &admins.get(0).unwrap()),
        Err(Ok(ContractError::ProposalAlreadyApproved))
    );
    fx.client
        .approve_admin_operation(&id, &admins.get(1).unwrap());
    fx.client.execute_admin_operation(&id);
    assert!(fx.client.is_paused());

    // Executed proposals are single-use.
    assert_eq!(
        fx.client.try_execute_admin_operation(&id),
        Err(Ok(ContractError::ProposalNotFound))
    );
}

#[test]
fn non_members_cannot_propose_or_approve() {
    let fx = Fixture::new();
    let admins = multisig(&fx, 2);
    let outsider = Address::generate(&fx.env);
    assert_eq!(
        fx.client
            .try_propose_admin_operation(&outsider, &AdminOperation::Pause, &1_000),
        Err(Ok(ContractError::Unauthorized))
    );
    let id =
        fx.client
            .propose_admin_operation(&admins.get(0).unwrap(), &AdminOperation::Pause, &1_000);
    assert_eq!(
        fx.client.try_approve_admin_operation(&id, &outsider),
        Err(Ok(ContractError::Unauthorized))
    );
}

#[test]
fn expired_proposals_are_rejected() {
    let fx = Fixture::new();
    fx.set_time(500);
    let admins = multisig(&fx, 2);
    let a0 = admins.get(0).unwrap();
    assert_eq!(
        fx.client
            .try_propose_admin_operation(&a0, &AdminOperation::Pause, &500),
        Err(Ok(ContractError::ProposalExpired))
    );
    let id = fx
        .client
        .propose_admin_operation(&a0, &AdminOperation::Pause, &600);
    fx.set_time(600);
    assert_eq!(
        fx.client
            .try_approve_admin_operation(&id, &admins.get(1).unwrap()),
        Err(Ok(ContractError::ProposalExpired))
    );
    assert_eq!(
        fx.client.try_execute_admin_operation(&id),
        Err(Ok(ContractError::ProposalExpired))
    );
}

#[test]
fn executes_each_admin_operation_kind() {
    let fx = Fixture::new();
    let admins = multisig(&fx, 1);
    let a0 = admins.get(0).unwrap();
    let run = |op: AdminOperation| {
        let id = fx.client.propose_admin_operation(&a0, &op, &1_000_000);
        fx.client.execute_admin_operation(&id);
    };

    run(AdminOperation::SetGracePeriod(42));
    assert_eq!(fx.client.get_grace_period(), 42);

    let (meter, _owner) = fx.register_and_fund("GOV_M", 5_000, PaymentPlan::UsageBased);
    run(AdminOperation::BulkDeactivate(vec![&fx.env, meter.clone()]));
    assert!(!fx.client.get_meter(&meter).active);

    run(AdminOperation::EmergencyWithdraw(2_000));
    assert_eq!(fx.token_client().balance(&fx.admin), 2_000);

    run(AdminOperation::Pause);
    assert!(fx.client.is_paused());
    run(AdminOperation::Unpause);
    assert!(!fx.client.is_paused());

    let new_admin = Address::generate(&fx.env);
    run(AdminOperation::RotateAdmin(new_admin.clone()));
    // The rotated admin is recorded on subsequent audited admin calls.
    fx.client.set_grace_period(&7);
    let filter = AuditLogFilter {
        action_type: None,
        admin: Some(new_admin),
        from_ts: None,
        to_ts: None,
    };
    assert!(fx.client.get_audit_logs(&filter, &0, &10).len() >= 1);
}

#[test]
fn emergency_withdraw_operation_checks_balance() {
    let fx = Fixture::new();
    let admins = multisig(&fx, 1);
    let a0 = admins.get(0).unwrap();
    let id = fx
        .client
        .propose_admin_operation(&a0, &AdminOperation::EmergencyWithdraw(1), &1_000);
    assert_eq!(
        fx.client.try_execute_admin_operation(&id),
        Err(Ok(ContractError::InsufficientBalance))
    );
}

#[test]
fn pause_unpause_and_auto_expiry() {
    let fx = Fixture::new();
    fx.set_time(10);
    fx.client.pause();
    assert_eq!(fx.client.try_pause(), Err(Ok(ContractError::AlreadyPaused)));
    fx.client.unpause();
    assert_eq!(fx.client.try_unpause(), Err(Ok(ContractError::NotPaused)));

    fx.client.pause();
    fx.advance(48 * 60 * 60);
    assert!(!fx.client.is_paused(), "pause auto-expires after 48h");
}

#[test]
fn freeze_blocks_payments_until_oracle_cosigned_unfreeze() {
    let fx = Fixture::new();
    fx.oracle();
    let (meter, owner) = fx.register("FRZ");
    fx.mint(&owner, 100);
    fx.client.freeze_contract();
    assert!(fx.client.is_frozen());
    assert_eq!(
        fx.client
            .try_make_payment(&meter, &owner, &100, &PaymentPlan::Daily, &None),
        Err(Ok(ContractError::ContractFrozen))
    );
    fx.client.unfreeze_contract();
    assert!(!fx.client.is_frozen());
    fx.client
        .make_payment(&meter, &owner, &100, &PaymentPlan::Daily, &None);
}

#[test]
fn unfreeze_requires_oracle_and_frozen_state() {
    let fx = Fixture::new();
    assert_eq!(
        fx.client.try_unfreeze_contract(),
        Err(Ok(ContractError::ContractNotFrozen))
    );
    fx.client.freeze_contract();
    assert_eq!(
        fx.client.try_unfreeze_contract(),
        Err(Ok(ContractError::OracleNotSet))
    );
}

#[test]
fn oracle_set_get_remove() {
    let fx = Fixture::new();
    assert_eq!(fx.client.get_oracle(), None);
    let oracle = fx.oracle();
    assert_eq!(fx.client.get_oracle(), Some(oracle));
    fx.client.remove_oracle();
    assert_eq!(fx.client.get_oracle(), None);
    let (meter, _) = fx.register_and_fund("ORA", 1_000, PaymentPlan::UsageBased);
    assert_eq!(
        fx.client.try_update_usage(&meter, &1, &1),
        Err(Ok(ContractError::OracleNotSet))
    );
}

#[test]
fn audit_log_pagination_is_capped_and_filters_by_time() {
    let fx = Fixture::new();
    for i in 0..5u64 {
        fx.set_time(1_000 * (i + 1));
        fx.client.set_grace_period(&i);
    }
    assert_eq!(fx.client.get_audit_log_count(), 5);
    let all = AuditLogFilter {
        action_type: None,
        admin: None,
        from_ts: None,
        to_ts: None,
    };
    assert_eq!(fx.client.get_audit_logs(&all, &0, &1_000).len(), 5);
    assert_eq!(fx.client.get_audit_logs(&all, &3, &10).len(), 2);

    let window = AuditLogFilter {
        action_type: None,
        admin: None,
        from_ts: Some(2_000),
        to_ts: Some(4_000),
    };
    assert_eq!(fx.client.get_audit_logs(&window, &0, &10).len(), 3);
    let by_action = AuditLogFilter {
        action_type: Some(String::from_str(&fx.env, "set_grace_period")),
        admin: Some(fx.admin.clone()),
        from_ts: None,
        to_ts: None,
    };
    assert_eq!(fx.client.get_audit_logs(&by_action, &0, &10).len(), 5);
}

#[test]
fn allowlist_aliases_and_idempotence() {
    let fx = Fixture::new();
    let a = Address::generate(&fx.env);
    fx.client.add_to_allowlist(&a);
    fx.client.add_to_allowlist(&a);
    assert_eq!(fx.client.get_allowlist().len(), 1);
    fx.client.remove_from_allowlist(&a);
    assert_eq!(fx.client.get_allowlist().len(), 0);
    let meter = fx.id("NOPE");
    assert_eq!(
        fx.client.try_register_meter(&meter, &a),
        Err(Ok(ContractError::Unauthorized))
    );
}

#[test]
fn reinitialize_is_rejected() {
    let fx = Fixture::new();
    assert_eq!(
        fx.client.try_initialize(&fx.admin, &fx.token),
        Err(Ok(ContractError::AlreadyInitialized))
    );
}
