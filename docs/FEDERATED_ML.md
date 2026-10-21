# Federated Learning for Privacy-Preserving ML

This document describes the federated learning (FL) subsystem used to train
usage-prediction models directly on meters (IoT devices) without ever moving
raw user data to a central server. Only model updates (weight deltas) are
shared, and those are protected by secure aggregation and a differential
privacy budget.

## Goals

- **Train usage prediction models on meters locally.** Each meter trains a
  small model on its own locally buffered readings.
- **Aggregate model updates without sharing raw data.** The coordinator only
  ever sees weight deltas and sample counts.
- **Improve the global model while preserving privacy.** Aggregated updates
  improve a shared global model; differential privacy and secure aggregation
  bound what any single party can learn.
- **Backend federated learning coordinator.** A server-side component that
  orchestrates rounds, collects updates, aggregates them, and publishes the
  new global model.
- **IoT local training capability.** A lightweight trainer that runs on the
  meter firmware/runtime.

## Architecture Overview

```
┌─────────────────────────────── Backend ───────────────────────────────┐
│                                                                        │
│   ┌──────────────────────────────┐        ┌────────────────────────┐   │
│   │ FederatedLearningCoordinator │◄──────►│   Global Model Store   │   │
│   │  - round lifecycle           │        │  (versioned weights)   │   │
│   │  - client selection          │        └────────────────────────┘   │
│   │  - secure aggregation        │                                     │
│   │  - privacy budget accounting │                                     │
│   └──────────────┬───────────────┘                                     │
│                  │  update upload / model download (HTTPS)            │
└──────────────────┼─────────────────────────────────────────────────────┘
                   │
      ┌────────────┼─────────────┬──────────────────┐
      │            │             │                  │
┌─────▼─────┐ ┌────▼──────┐ ┌────▼──────┐    ┌──────▼─────┐
│  Meter A  │ │  Meter B  │ │  Meter C  │ …  │  Meter N   │
│ LocalTrain│ │ LocalTrain│ │ LocalTrain│    │ LocalTrain │
│ + DP noise│ │ + DP noise│ │ + DP noise│    │ + DP noise │
└───────────┘ └───────────┘ └───────────┘    └────────────┘
```

### Components

| Component | Location | Responsibility |
|-----------|----------|----------------|
| `FederatedLearningCoordinator` | Backend | Drives rounds, selects clients, aggregates updates, tracks privacy budget |
| `LocalTrainer` | Meter (IoT) | Trains the model on local data, computes weight deltas |
| `SecureAggregator` | Backend | Combines masked updates so individual contributions stay hidden |
| `PrivacyBudget` | Backend + Meter | Tracks/limits cumulative privacy loss (ε, δ) |
| `GlobalModelStore` | Backend | Stores versioned global model weights |

## Local Training on Meters

Each meter keeps a rolling buffer of its own usage readings (e.g. hourly
consumption). When the coordinator announces a round, the meter:

1. Downloads the current global model weights (or uses the cached copy).
2. Trains for a small number of local epochs on its buffered data.
3. Computes the **weight delta** `Δw = w_local − w_global`.
4. Clips the delta to a bounded L2 norm (`clip_norm`) to limit sensitivity.
5. Adds calibrated Gaussian noise to the clipped delta (local DP).
6. Uploads `{client_id, round_id, delta, sample_count}` — never raw data.

Local training is intentionally small (few features, few epochs) so it fits
constrained meter hardware. The model is a lightweight regression/MLP over
features such as time-of-day, day-of-week, and recent consumption lags.

### Update Format

Updates contain **only** weight deltas and sample counts:

```json
{
  "client_id": "meter-00042",
  "round_id": 17,
  "model_version": 16,
  "sample_count": 168,
  "delta": {
    "layer_0.weights": [0.0012, -0.0034, ...],
    "layer_0.bias": [0.0001, ...],
    "layer_1.weights": [...],
    "layer_1.bias": [...]
  },
  "dp": {
    "clip_norm": 1.0,
    "noise_multiplier": 1.1,
    "epsilon_spent": 0.08
  }
}
```

No raw readings, identifiers of individuals, or timestamps of individual
events are transmitted. `sample_count` is used only to weight the aggregation.

## Secure Aggregation

The coordinator uses secure aggregation so that it can compute the **sum** of
client deltas without seeing any individual delta:

1. Clients agree on pairwise masks (via a key-agreement handshake).
2. Each client adds its pairwise masks to its (noised) delta before upload.
3. The coordinator sums all masked deltas; pairwise masks cancel out.
4. The coordinator recovers only the aggregate `Σ Δw` and `Σ sample_count`.

Because masks cancel only in the sum, the coordinator never observes an
individual client's update. If a client drops out, the protocol performs a
recovery step so the remaining masks still cancel.

The aggregate is then applied to the global model:

```
w_global_new = w_global + (Σ (sample_count_i · Δw_i)) / (Σ sample_count_i)
```

## Privacy Budget

Differential privacy is enforced with a per-client and global privacy budget
expressed as `(ε, δ)`:

- **Local DP on meters:** each delta is clipped and noised before upload.
- **Budget accounting:** the coordinator tracks cumulative `ε` per client and
  globally. Once a client's budget is exhausted, it is excluded from future
  rounds until the budget resets (e.g. daily/weekly).
- **Composition:** budgets are composed across rounds using standard DP
  composition (or RDP accounting) to bound total privacy loss.
- **Minimum cohort size:** a round only proceeds if at least
  `min_clients_per_round` clients participate, preventing small-cohort
  inference.

Configuration (example):

```yaml
federated_learning:
  rounds: 100
  clients_per_round: 50
  min_clients_per_round: 10
  local_epochs: 2
  learning_rate: 0.01
  clip_norm: 1.0
  noise_multiplier: 1.1
  target_epsilon: 8.0
  target_delta: 1.0e-5
```

## Coordinator API

The backend coordinator exposes a small HTTP/JSON API. All endpoints require
device authentication.

| Method | Path | Description |
|--------|------|-------------|
| `GET`  | `/fl/rounds/current` | Get the current round descriptor (round id, model version, hyperparameters) |
| `GET`  | `/fl/model/{version}` | Download global model weights for a version |
| `POST` | `/fl/rounds/{round_id}/updates` | Submit a masked, noised weight delta + sample count |
| `GET`  | `/fl/rounds/{round_id}/status` | Round status (open / aggregating / complete) |
| `GET`  | `/fl/privacy/budget/{client_id}` | Remaining privacy budget for a client |

### Round Lifecycle

1. **Open** — coordinator publishes a round descriptor and the current global
   model version.
2. **Collect** — clients train locally and upload masked updates until
   `clients_per_round` is reached or a timeout elapses.
3. **Aggregate** — secure aggregation recovers the summed delta; the
   coordinator updates the global model and increments the model version.
4. **Complete** — the new global model is published; the next round opens.

### Example: submitting an update

```http
POST /fl/rounds/17/updates
Content-Type: application/json
Authorization: Bearer <device-token>

{
  "client_id": "meter-00042",
  "round_id": 17,
  "model_version": 16,
  "sample_count": 168,
  "masked_delta": { "layer_0.weights": [...], ... },
  "dp": { "clip_norm": 1.0, "noise_multiplier": 1.1, "epsilon_spent": 0.08 }
}
```

## IoT Integration

On the meter, the `LocalTrainer` is wired into the existing telemetry loop:

- **Data buffering:** readings are appended to a bounded local buffer; old
  readings are evicted to respect memory limits.
- **Scheduling:** training runs during idle windows (low CPU / off-peak) to
  avoid impacting metering.
- **Model caching:** the last global model is cached so training can proceed
  even if the network is briefly unavailable; updates are uploaded when
  connectivity returns and the round is still open.
- **Resource limits:** local epochs, batch size, and model size are capped by
  device configuration.
- **Failure handling:** if a round closes before upload, the local delta is
  discarded (not carried over) to keep rounds independent.

Example meter configuration:

```yaml
federated_learning:
  enabled: true
  buffer_size: 720          # e.g. 30 days of hourly readings
  local_epochs: 2
  batch_size: 32
  clip_norm: 1.0
  noise_multiplier: 1.1
  train_window: "02:00-04:00"
```

## Running Tests

Federated learning tests cover local training, update format, secure
aggregation correctness, privacy budget accounting, and end-to-end round
execution.

```bash
# Run all federated learning tests
pytest tests/federated -v

# Run a specific area
pytest tests/federated/test_local_trainer.py -v
pytest tests/federated/test_secure_aggregation.py -v
pytest tests/federated/test_coordinator.py -v
pytest tests/federated/test_privacy_budget.py -v
```

Key test scenarios:

- **Local training:** a meter trains on synthetic readings and produces a
  delta with the expected shape and a bounded norm.
- **Update format:** uploaded updates contain only deltas and sample counts —
  no raw data fields.
- **Secure aggregation:** the aggregate of masked updates equals the aggregate
  of unmasked updates, and individual updates are not recoverable.
- **Privacy budget:** cumulative `ε` is tracked correctly and clients are
  excluded once their budget is exhausted.
- **End-to-end:** a full round improves the global model's loss on a held-out
  synthetic dataset while respecting the privacy budget.

## Security & Privacy Summary

- Raw data never leaves the meter.
- Only clipped, noised weight deltas and sample counts are transmitted.
- Secure aggregation hides individual contributions from the coordinator.
- A differential privacy budget bounds cumulative information leakage.
- A minimum cohort size prevents small-group inference.
- All communication is authenticated and encrypted in transit (HTTPS/TLS).