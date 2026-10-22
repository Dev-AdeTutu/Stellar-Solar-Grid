# Micro-Grid Island Mode

## Overview

Island mode allows the micro-grid to operate autonomously when disconnected from the main utility grid. During an outage, meters form a self-sufficient network using local generation and storage, and continue to share energy peer-to-peer (P2P) within the island.

Key capabilities:

- Automatic detection of main grid disconnection
- Seamless switch to island mode using local generation/storage
- P2P energy sharing among meters within the island
- Service continuity during the outage
- Automatic resynchronization when the main grid reconnects

## Island Detection

Island detection is performed by the IoT layer on each meter and aggregated by the grid controller.

Detection signals:

- **Voltage presence**: Loss of nominal grid voltage at the point of common coupling (PCC) for a configured duration.
- **Frequency deviation**: Grid frequency outside the allowed band (e.g. `50 Hz ± 0.5 Hz`).
- **Phase/angle drift**: Loss of phase lock with the main grid reference.
- **Communication heartbeat**: Loss of heartbeat from the grid controller / substation.
- **Power flow anomaly**: Reverse or zero power flow at the PCC inconsistent with local load.

A disconnection is declared when the configured number of signals (see `island.detection.minSignals`) are present for at least `island.detection.confirmDelayMs`. This debouncing avoids false positives from transient faults.

## State Transitions

The system operates as a state machine:

```
GRID_CONNECTED ──(disconnection detected)──▶ ISLANDING
ISLANDING ──(local sources online)──▶ ISLAND_MODE
ISLAND_MODE ──(grid restored & synchronized)──▶ RESYNCING
RESYNCING ──(sync complete)──▶ GRID_CONNECTED
ISLANDING / ISLAND_MODE ──(fault)──▶ FAULT
```

| State | Description |
|-------|-------------|
| `GRID_CONNECTED` | Normal operation, grid is the reference. |
| `ISLANDING` | Disconnection detected; local sources are being brought online and the island reference is being established. |
| `ISLAND_MODE` | Autonomous operation; P2P sharing active; island reference (voltage/frequency) maintained by a designated master source. |
| `RESYNCING` | Grid restored; island is being synchronized (voltage, frequency, phase) before reconnection. |
| `FAULT` | Unrecoverable condition; requires operator intervention. |

Transitions are logged with timestamps and the triggering signals for auditability.

## P2P Energy Sharing Rules

While in `ISLAND_MODE`, energy is shared among meters within the island according to these rules:

1. **Local-first**: Each meter satisfies its own load from local generation/storage before participating in sharing.
2. **Priority by criticality**: Loads are prioritized (critical > important > normal). Critical loads are served first.
3. **Surplus allocation**: Surplus energy from a producer is offered to the island pool and allocated to consumers in priority order.
4. **Storage reserve**: Storage systems retain a configurable minimum state of charge (`island.sharing.minReservePercent`) to preserve island stability; energy below this reserve is not shared.
5. **Fair distribution**: When demand exceeds supply, available energy is distributed proportionally to consumer priority and demand.
6. **Loss-aware routing**: Sharing respects configured line losses and transfer limits between nodes.
7. **No export**: Energy is never exported beyond the island boundary while islanded.

Sharing decisions are recomputed on each control cycle (`island.sharing.intervalMs`).

## Auto-Resync Process

When the main grid is detected as restored:

1. The controller enters `RESYNCING`.
2. Grid voltage, frequency, and phase are measured at the PCC.
3. The island reference is adjusted to match the grid (frequency/voltage/phase alignment).
4. Once within synchronization tolerances (`island.resync.voltageTolerance`, `island.resync.frequencyTolerance`, `island.resync.phaseTolerance`) for `island.resync.stableMs`, the PCC breaker closes.
5. P2P sharing is gracefully wound down and normal grid-connected operation resumes (`GRID_CONNECTED`).
6. If synchronization fails within `island.resync.timeoutMs`, the system returns to `ISLAND_MODE` and retries.

## API Endpoints

| Method | Path | Description |
|--------|------|-------------|
| `GET` | `/api/island/status` | Current island state, active signals, and since-timestamp. |
| `GET` | `/api/island/meters` | Meters participating in the island and their roles. |
| `GET` | `/api/island/sharing` | Current P2P sharing allocations. |
| `POST` | `/api/island/enter` | Manually force entry into island mode (operator override). |
| `POST` | `/api/island/exit` | Request exit / resync to grid. |
| `GET` | `/api/island/config` | Retrieve island configuration. |
| `PUT` | `/api/island/config` | Update island configuration. |
| `GET` | `/api/island/events` | Transition and detection event log. |

Example status response:

```json
{
  "state": "ISLAND_MODE",
  "since": "2024-01-01T12:00:00Z",
  "signals": ["voltageLoss", "frequencyDeviation"],
  "masterSource": "meter-07",
  "meters": 12,
  "sharingActive": true
}
```

## Configuration

Island mode is configured under the `island` namespace:

```yaml
island:
  enabled: true
  detection:
    minSignals: 2
    confirmDelayMs: 500
    voltageThreshold: 0.8      # fraction of nominal
    frequencyBand: 0.5         # Hz
  sharing:
    enabled: true
    intervalMs: 1000
    minReservePercent: 20
    allowExport: false
  resync:
    voltageTolerance: 0.05     # fraction of nominal
    frequencyTolerance: 0.1    # Hz
    phaseTolerance: 5          # degrees
    stableMs: 2000
    timeoutMs: 60000
```

| Key | Description | Default |
|-----|-------------|---------|
| `island.enabled` | Enable island mode support. | `true` |
| `island.detection.minSignals` | Signals required to declare disconnection. | `2` |
| `island.detection.confirmDelayMs` | Debounce delay before declaring disconnection. | `500` |
| `island.detection.voltageThreshold` | Voltage drop threshold (fraction of nominal). | `0.8` |
| `island.detection.frequencyBand` | Allowed frequency deviation (Hz). | `0.5` |
| `island.sharing.enabled` | Enable P2P sharing while islanded. | `true` |
| `island.sharing.intervalMs` | Sharing recomputation interval. | `1000` |
| `island.sharing.minReservePercent` | Minimum storage reserve not shared. | `20` |
| `island.sharing.allowExport` | Allow export beyond island (always `false` while islanded). | `false` |
| `island.resync.voltageTolerance` | Voltage match tolerance for resync. | `0.05` |
| `island.resync.frequencyTolerance` | Frequency match tolerance for resync. | `0.1` |
| `island.resync.phaseTolerance` | Phase match tolerance (degrees). | `5` |
| `island.resync.stableMs` | Required stable duration before closing breaker. | `2000` |
| `island.resync.timeoutMs` | Resync attempt timeout before retry. | `60000` |

## Testing

Island mode transitions are covered by automated tests, including:

- Detection of grid disconnection from each signal and combinations.
- Transition `GRID_CONNECTED → ISLANDING → ISLAND_MODE`.
- P2P sharing allocation and reserve enforcement.
- Service continuity for critical loads during outage.
- Auto-resync success and timeout/retry paths.
- Manual enter/exit overrides.