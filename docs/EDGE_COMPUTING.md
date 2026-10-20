# Edge Computing for Meters

This document describes the edge computing capabilities added to the meter platform (issue #1069). Edge computing moves latency-sensitive processing onto the meter itself so that local inference, anomaly detection, and autonomy continue to work even when cloud connectivity is unavailable.

## Goals

- **Deploy ML models to meter edge devices** — models are versioned, signed, and pushed to devices.
- **Local inference without cloud connectivity** — inference runs entirely on-device.
- **Edge-based anomaly detection** — anomalies are detected locally in real time.
- **Sync results when online** — buffered results are uploaded and reconciled once connectivity returns.
- **Reduced latency and bandwidth** — only compact results (not raw telemetry) leave the device.

## Architecture Overview

```
┌─────────────────────────────────────────────────────────────┐
│                        Meter Edge Device                      │
│                                                               │
│  ┌────────────┐   ┌──────────────┐   ┌───────────────────┐   │
│  │  Sensors   │──▶│ Edge Runtime │──▶│ Local ML Inference │   │
│  └────────────┘   │  (scheduler) │   └─────────┬─────────┘   │
│                   │              │             │             │
│                   │              │   ┌─────────▼─────────┐   │
│                   │              │──▶│ Anomaly Detection │   │
│                   │              │   └─────────┬─────────┘   │
│                   │              │             │             │
│                   │              │   ┌─────────▼─────────┐   │
│                   │              │──▶│  Result Buffer    │   │
│                   └──────────────┘   │ (offline queue)   │   │
│                                      └─────────┬─────────┘   │
│                                                │             │
│                                      ┌─────────▼─────────┐   │
│                                      │   Sync Client     │   │
│                                      └─────────┬─────────┘   │
└────────────────────────────────────────────────┼─────────────┘
                                                 │ (when online)
                                                 ▼
                                        ┌─────────────────┐
                                        │   Cloud Backend │
                                        │  (ingest + ML   │
                                        │   registry)     │
                                        └─────────────────┘
```

### Components

| Component | Responsibility |
|-----------|----------------|
| **Edge Runtime** | Schedules inference and detection cycles, manages model lifecycle, enforces resource limits. |
| **Model Store** | Persists deployed models locally with version metadata and integrity checks. |
| **Local Inference Engine** | Loads a model and runs inference on sensor windows without any network calls. |
| **Anomaly Detector** | Applies thresholds / model outputs to flag anomalies on-device. |
| **Result Buffer** | Durable, bounded FIFO queue of results awaiting upload. |
| **Sync Client** | Uploads buffered results and acknowledges them when connectivity is available. |

## Model Deployment Flow

1. **Author & register** — a model is trained in the cloud and registered in the ML registry with a version, checksum, and signature.
2. **Target** — the registry marks the model as available for a device group (e.g. by meter model or firmware).
3. **Download** — the edge runtime polls (or receives a push notification) for new model versions and downloads the artifact over a secure channel.
4. **Verify** — the runtime verifies the checksum and signature before accepting the model.
5. **Stage & activate** — the new model is staged alongside the current one, validated with a smoke inference, then atomically activated. The previous model is retained for rollback.
6. **Report** — the device reports the active model version back to the cloud.

If any step fails, the device keeps running the last known-good model.

## Local Inference

- Inference runs on sliding windows of sensor data collected by the runtime.
- The engine is fully self-contained: no network access is required to load a model or run inference.
- Results include the model version, input window bounds, output values, and a confidence score.
- Resource limits (CPU/memory budget per cycle) are enforced by the runtime to avoid starving metering functions.

## Edge-Based Anomaly Detection

- The anomaly detector consumes inference outputs and/or raw signal statistics.
- Configurable thresholds and model-driven scoring determine whether a reading is anomalous.
- Detected anomalies are emitted immediately to local alerting (e.g. local display/relay) and enqueued for cloud sync.
- Detection is deterministic and works identically offline and online.

## Offline Buffering and Sync

- All results (inference outputs and anomalies) are written to a **durable, bounded buffer**.
- When the buffer is full, the oldest low-priority entries are dropped first; anomalies are prioritized and retained longer.
- The **sync client** periodically attempts upload:
  - On success, uploaded entries are acknowledged and removed from the buffer.
  - On failure (offline / error), entries remain queued and retried with backoff.
- Each result carries a unique ID so the cloud can deduplicate on retries.
- Sync is idempotent: re-sending an already-acknowledged result is a no-op.

## Configuration

Edge behavior is controlled via configuration (environment variables or a config file). Example:

```yaml
edge:
  enabled: true
  runtime:
    cycle_interval_ms: 1000        # how often inference/detection runs
    max_cpu_percent: 25            # resource budget per cycle
    max_memory_mb: 64
  model:
    store_path: /var/lib/meter/models
    active_version: "1.4.0"
    verify_signature: true
    rollback_on_failure: true
  inference:
    window_size: 60                # samples per inference window
    confidence_threshold: 0.6
  anomaly:
    enabled: true
    score_threshold: 0.8
    min_consecutive: 2             # consecutive hits before flagging
  buffer:
    path: /var/lib/meter/buffer
    max_entries: 10000
    prioritize_anomalies: true
  sync:
    endpoint: https://cloud.example.com/edge/results
    interval_ms: 30000
    batch_size: 200
    max_retries: 10
    backoff_ms: 5000
```

### Key settings

| Setting | Description |
|---------|-------------|
| `edge.enabled` | Master switch for edge processing. |
| `runtime.cycle_interval_ms` | Cadence of the inference/detection loop. |
| `model.active_version` | Model version to load at startup. |
| `model.verify_signature` | Enforce artifact signature verification. |
| `inference.window_size` | Number of samples per inference window. |
| `anomaly.score_threshold` | Score above which a reading is anomalous. |
| `buffer.max_entries` | Maximum buffered results before eviction. |
| `sync.interval_ms` | How often the sync client attempts upload. |

## Running the Edge Tests

The edge processing test suite covers model deployment, offline inference, anomaly detection, buffering, and sync.

```bash
# Run all edge-related tests
pytest tests/edge -v

# Run a specific area
pytest tests/edge/test_inference.py -v
pytest tests/edge/test_anomaly.py -v
pytest tests/edge/test_buffer_sync.py -v
pytest tests/edge/test_model_deployment.py -v
```

The tests use a simulated device and a mock cloud endpoint, so they run fully offline and require no external services.

## Operational Notes

- **Autonomy:** the device continues metering and detecting anomalies with no cloud connection.
- **Bandwidth:** only compact results and anomalies are uploaded, not raw telemetry.
- **Latency:** inference and detection happen locally in the runtime cycle (sub-second by default).
- **Safety:** model activation is atomic with rollback; a failed deployment never disrupts the running model.
- **Observability:** the runtime exposes counters for cycles run, anomalies detected, buffer depth, and sync success/failure.