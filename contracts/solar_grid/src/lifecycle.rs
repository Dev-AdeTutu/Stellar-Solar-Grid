use soroban_sdk::{
    contracterror, contracttype, symbol_short, Address, Bytes, BytesN, Env, String, Symbol, Vec,
};

/// Errors that can occur during lifecycle tracking operations.
#[contracterror]
#[derive(Copy, Clone, Debug, Eq, PartialEq, PartialOrd, Ord)]
#[repr(u32)]
pub enum LifecycleError {
    /// The meter lifecycle record already exists.
    AlreadyRegistered = 1,
    /// The meter lifecycle record was not found.
    NotFound = 2,
    /// The caller is not authorized to perform this action.
    Unauthorized = 3,
    /// The provided event type is invalid.
    InvalidEventType = 4,
    /// The meter has already been certified for recycling.
    AlreadyRecycled = 5,
    /// The meter has not yet reached end-of-life.
    NotEndOfLife = 6,
    /// The material recovery amount is invalid.
    InvalidRecoveryAmount = 7,
    /// The manufacturing record is invalid.
    InvalidManufacturingRecord = 8,
}

/// The type of lifecycle event recorded for a meter.
#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub enum LifecycleEventType {
    Installation,
    Repair,
    Upgrade,
    Inspection,
    Transfer,
    Decommission,
    Other,
}

/// A record of the manufacturing origin and materials of a meter.
#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct ManufacturingRecord {
    /// The manufacturer of the meter.
    pub manufacturer: Address,
    /// The facility or location where the meter was manufactured.
    pub facility: String,
    /// The date of manufacture (Unix timestamp).
    pub manufactured_at: u64,
    /// The batch or serial number of the meter.
    pub batch_id: String,
    /// The materials used in the meter (e.g., "copper", "silicon", "plastic").
    pub materials: Vec<String>,
    /// The total mass of the meter in grams.
    pub mass_grams: u64,
    /// A hash of the manufacturing certificate / provenance document.
    pub provenance_hash: BytesN<32>,
}

/// A single lifecycle event for a meter.
#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct LifecycleEvent {
    /// The type of the event.
    pub event_type: LifecycleEventType,
    /// The address that performed the event.
    pub actor: Address,
    /// The timestamp of the event (Unix timestamp).
    pub timestamp: u64,
    /// A description or notes about the event.
    pub description: String,
    /// An optional hash of supporting documentation.
    pub document_hash: Option<BytesN<32>>,
}

/// A recycling certificate issued at end-of-life.
#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct RecyclingCertificate {
    /// The recycling facility that issued the certificate.
    pub recycler: Address,
    /// The timestamp of certification (Unix timestamp).
    pub certified_at: u64,
    /// The recycling method used (e.g., "mechanical", "chemical").
    pub method: String,
    /// A hash of the recycling certificate document.
    pub certificate_hash: BytesN<32>,
    /// Whether the recycling was verified by an independent auditor.
    pub verified: bool,
}

/// A record of material recovery from a recycled meter.
#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct MaterialRecovery {
    /// The material that was recovered (e.g., "copper", "silicon").
    pub material: String,
    /// The mass of the recovered material in grams.
    pub mass_grams: u64,
    /// The timestamp of recovery (Unix timestamp).
    pub recovered_at: u64,
    /// The address of the facility that performed the recovery.
    pub facility: Address,
}

/// The complete lifecycle record of a meter.
#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct MeterLifecycle {
    /// The unique identifier of the meter.
    pub meter_id: BytesN<32>,
    /// The manufacturing record.
    pub manufacturing: ManufacturingRecord,
    /// The list of lifecycle events.
    pub events: Vec<LifecycleEvent>,
    /// The recycling certificate, if the meter has been recycled.
    pub recycling: Option<RecyclingCertificate>,
    /// The list of material recovery records.
    pub recoveries: Vec<MaterialRecovery>,
    /// Whether the meter has reached end-of-life.
    pub end_of_life: bool,
    /// Whether the meter is compliant with circular economy regulations.
    pub compliant: bool,
}

/// Storage keys for the lifecycle module.
#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub enum LifecycleKey {
    /// Maps a meter ID to its lifecycle record.
    Meter(BytesN<32>),
    /// Maps a meter ID to its list of lifecycle events.
    Events(BytesN<32>),
    /// Maps a meter ID to its recycling certificate.
    Recycling(BytesN<32>),
    /// Maps a meter ID to its list of material recoveries.
    Recoveries(BytesN<32>),
}

/// Emitted when a meter is registered with its manufacturing record.
#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct ManufacturingRecorded {
    pub meter_id: BytesN<32>,
    pub manufacturer: Address,
    pub batch_id: String,
}

/// Emitted when a lifecycle event is recorded.
#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct LifecycleEventRecorded {
    pub meter_id: BytesN<32>,
    pub event_type: LifecycleEventType,
    pub actor: Address,
}

/// Emitted when a meter is certified for recycling.
#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct RecyclingCertified {
    pub meter_id: BytesN<32>,
    pub recycler: Address,
    pub verified: bool,
}

/// Emitted when material recovery is recorded.
#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct MaterialRecoveryRecorded {
    pub meter_id: BytesN<32>,
    pub material: String,
    pub mass_grams: u64,
}

/// Emitted when compliance status is checked.
#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct ComplianceChecked {
    pub meter_id: BytesN<32>,
    pub compliant: bool,
}

/// Records the manufacturing origin and materials of a meter.
///
/// # Arguments
/// * `env` - The contract environment.
/// * `meter_id` - The unique identifier of the meter.
/// * `manufacturing` - The manufacturing record.
///
/// # Returns
/// `Ok(())` on success, or a `LifecycleError` on failure.
pub fn record_manufacturing(
    env: Env,
    meter_id: BytesN<32>,
    manufacturing: ManufacturingRecord,
) -> Result<(), LifecycleError> {
    let key = LifecycleKey::Meter(meter_id.clone());
    if env.storage().persistent().has(&key) {
        return Err(LifecycleError::AlreadyRegistered);
    }

    if manufacturing.mass_grams == 0 || manufacturing.materials.is_empty() {
        return Err(LifecycleError::InvalidManufacturingRecord);
    }

    let lifecycle = MeterLifecycle {
        meter_id: meter_id.clone(),
        manufacturing: manufacturing.clone(),
        events: Vec::new(&env),
        recycling: None,
        recoveries: Vec::new(&env),
        end_of_life: false,
        compliant: false,
    };

    env.storage().persistent().set(&key, &lifecycle);
    env.storage()
        .persistent()
        .set(&LifecycleKey::Events(meter_id.clone()), &Vec::<LifecycleEvent>::new(&env));
    env.storage()
        .persistent()
        .set(&LifecycleKey::Recoveries(meter_id.clone()), &Vec::<MaterialRecovery>::new(&env));

    env.events().publish(
        (symbol_short!("mfg_rec"), meter_id.clone()),
        ManufacturingRecorded {
            meter_id,
            manufacturer: manufacturing.manufacturer,
            batch_id: manufacturing.batch_id,
        },
    );

    Ok(())
}

/// Records a lifecycle event (installation, repair, upgrade, etc.) for a meter.
///
/// # Arguments
/// * `env` - The contract environment.
/// * `meter_id` - The unique identifier of the meter.
/// * `event` - The lifecycle event to record.
///
/// # Returns
/// `Ok(())` on success, or a `LifecycleError` on failure.
pub fn record_lifecycle_event(
    env: Env,
    meter_id: BytesN<32>,
    event: LifecycleEvent,
) -> Result<(), LifecycleError> {
    let key = LifecycleKey::Meter(meter_id.clone());
    let mut lifecycle: MeterLifecycle = env
        .storage()
        .persistent()
        .get(&key)
        .ok_or(LifecycleError::NotFound)?;

    if lifecycle.recycling.is_some() {
        return Err(LifecycleError::AlreadyRecycled);
    }

    if event.timestamp == 0 {
        return Err(LifecycleError::InvalidEventType);
    }

    let mut events: Vec<LifecycleEvent> = env
        .storage()
        .persistent()
        .get(&LifecycleKey::Events(meter_id.clone()))
        .unwrap_or_else(|| Vec::new(&env));

    events.push_back(event.clone());
    lifecycle.events = events.clone();

    if event.event_type == LifecycleEventType::Decommission {
        lifecycle.end_of_life = true;
    }

    env.storage().persistent().set(&key, &lifecycle);
    env.storage()
        .persistent()
        .set(&LifecycleKey::Events(meter_id.clone()), &events);

    env.events().publish(
        (symbol_short!("lc_event"), meter_id.clone()),
        LifecycleEventRecorded {
            meter_id,
            event_type: event.event_type,
            actor: event.actor,
        },
    );

    Ok(())
}

/// Certifies a meter for recycling at end-of-life.
///
/// # Arguments
/// * `env` - The contract environment.
/// * `meter_id` - The unique identifier of the meter.
/// * `certificate` - The recycling certificate.
///
/// # Returns
/// `Ok(())` on success, or a `LifecycleError` on failure.
pub fn certify_recycling(
    env: Env,
    meter_id: BytesN<32>,
    certificate: RecyclingCertificate,
) -> Result<(), LifecycleError> {
    let key = LifecycleKey::Meter(meter_id.clone());
    let mut lifecycle: MeterLifecycle = env
        .storage()
        .persistent()
        .get(&key)
        .ok_or(LifecycleError::NotFound)?;

    if lifecycle.recycling.is_some() {
        return Err(LifecycleError::AlreadyRecycled);
    }

    if !lifecycle.end_of_life {
        return Err(LifecycleError::NotEndOfLife);
    }

    if certificate.certified_at == 0 {
        return Err(LifecycleError::InvalidEventType);
    }

    lifecycle.recycling = Some(certificate.clone());
    lifecycle.end_of_life = true;

    env.storage().persistent().set(&key, &lifecycle);
    env.storage()
        .persistent()
        .set(&LifecycleKey::Recycling(meter_id.clone()), &certificate);

    env.events().publish(
        (symbol_short!("recycle"), meter_id.clone()),
        RecyclingCertified {
            meter_id,
            recycler: certificate.recycler,
            verified: certificate.verified,
        },
    );

    Ok(())
}

/// Records material recovery from a recycled meter.
///
/// # Arguments
/// * `env` - The contract environment.
/// * `meter_id` - The unique identifier of the meter.
/// * `recovery` - The material recovery record.
///
/// # Returns
/// `Ok(())` on success, or a `LifecycleError` on failure.
pub fn record_material_recovery(
    env: Env,
    meter_id: BytesN<32>,
    recovery: MaterialRecovery,
) -> Result<(), LifecycleError> {
    let key = LifecycleKey::Meter(meter_id.clone());
    let mut lifecycle: MeterLifecycle = env
        .storage()
        .persistent()
        .get(&key)
        .ok_or(LifecycleError::NotFound)?;

    if lifecycle.recycling.is_none() {
        return Err(LifecycleError::NotEndOfLife);
    }

    if recovery.mass_grams == 0 {
        return Err(LifecycleError::InvalidRecoveryAmount);
    }

    let mut recoveries: Vec<MaterialRecovery> = env
        .storage()
        .persistent()
        .get(&LifecycleKey::Recoveries(meter_id.clone()))
        .unwrap_or_else(|| Vec::new(&env));

    recoveries.push_back(recovery.clone());
    lifecycle.recoveries = recoveries.clone();

    env.storage().persistent().set(&key, &lifecycle);
    env.storage()
        .persistent()
        .set(&LifecycleKey::Recoveries(meter_id.clone()), &recoveries);

    env.events().publish(
        (symbol_short!("recovery"), meter_id.clone()),
        MaterialRecoveryRecorded {
            meter_id,
            material: recovery.material,
            mass_grams: recovery.mass_grams,
        },
    );

    Ok(())
}

/// Retrieves the complete lifecycle record of a meter.
///
/// # Arguments
/// * `env` - The contract environment.
/// * `meter_id` - The unique identifier of the meter.
///
/// # Returns
/// The `MeterLifecycle` record, or a `LifecycleError` if not found.
pub fn get_meter_lifecycle(env: Env, meter_id: BytesN<32>) -> Result<MeterLifecycle, LifecycleError> {
    env.storage()
        .persistent()
        .get(&LifecycleKey::Meter(meter_id))
        .ok_or(LifecycleError::NotFound)
}

/// Retrieves the list of lifecycle events for a meter.
///
/// # Arguments
/// * `env` - The contract environment.
/// * `meter_id` - The unique identifier of the meter.
///
/// # Returns
/// The list of `LifecycleEvent`s, or a `LifecycleError` if not found.
pub fn get_lifecycle_events(
    env: Env,
    meter_id: BytesN<32>,
) -> Result<Vec<LifecycleEvent>, LifecycleError> {
    if !env
        .storage()
        .persistent()
        .has(&LifecycleKey::Meter(meter_id.clone()))
    {
        return Err(LifecycleError::NotFound);
    }

    Ok(env
        .storage()
        .persistent()
        .get(&LifecycleKey::Events(meter_id))
        .unwrap_or_else(|| Vec::new(&env)))
}

/// Checks whether a meter is compliant with circular economy regulations.
///
/// A meter is considered compliant when:
/// - It has a valid manufacturing record with materials and mass.
/// - It has been certified for recycling (end-of-life).
/// - The recycling certificate is verified.
/// - At least one material recovery has been recorded.
///
/// # Arguments
/// * `env` - The contract environment.
/// * `meter_id` - The unique identifier of the meter.
///
/// # Returns
/// `true` if compliant, `false` otherwise.
pub fn check_circular_economy_compliance(env: Env, meter_id: BytesN<32>) -> Result<bool, LifecycleError> {
    let key = LifecycleKey::Meter(meter_id.clone());
    let mut lifecycle: MeterLifecycle = env
        .storage()
        .persistent()
        .get(&key)
        .ok_or(LifecycleError::NotFound)?;

    let has_manufacturing =
        lifecycle.manufacturing.mass_grams > 0 && !lifecycle.manufacturing.materials.is_empty();

    let recycling_verified = match &lifecycle.recycling {
        Some(cert) => cert.verified,
        None => false,
    };

    let has_recovery = !lifecycle.recoveries.is_empty();

    let compliant = has_manufacturing && recycling_verified && has_recovery;

    lifecycle.compliant = compliant;
    env.storage().persistent().set(&key, &lifecycle);

    env.events().publish(
        (symbol_short!("compliance"), meter_id.clone()),
        ComplianceChecked {
            meter_id,
            compliant,
        },
    );

    Ok(compliant)
}