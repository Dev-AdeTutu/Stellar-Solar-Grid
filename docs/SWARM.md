# Meter Swarm Intelligence

## Overview

Meter Swarm Intelligence enables meters to collectively optimize behavior by sharing anonymized performance data, learning optimal strategies together, and achieving emergent load balancing without central control. Each meter remains autonomous while contributing to and benefiting from network-wide intelligence.

## Core Principles

1. **Anonymity** — Meters never share identifying information, only aggregated performance metrics.
2. **Autonomy** — No central controller dictates behavior; meters self-organize.
3. **Emergence** — Global optimization arises from local interactions.
4. **Adaptivity** — The swarm continuously responds to changing network conditions.

## Anonymized Data Sharing

Meters periodically publish anonymized performance data to the swarm. Shared data includes:

- **Performance metrics**: throughput, latency, success rates, error counts
- **Load indicators**: current utilization, queue depth, capacity headroom
- **Strategy outcomes**: which strategies performed well under which conditions
- **Network conditions**: observed congestion, peer availability, link quality

### Anonymization Guarantees

- No meter identifiers, addresses, or location data are transmitted
- Metrics are bucketed and aggregated before sharing
- Data is signed with ephemeral swarm keys, not persistent identities
- Differential privacy noise is applied to prevent inference attacks

```json
{
  "metrics": {
    "throughput": 0.87,
    "latency_ms": 42,
    "success_rate": 0.995,
    "utilization": 0.63
  },
  "strategy": "adaptive_backoff_v2",
  "conditions": "moderate_congestion",
  "outcome": "positive"
}
```

## Collective Learning

Meters learn optimal strategies collectively through a distributed reinforcement learning process:

1. **Local evaluation** — Each meter evaluates its current strategy against local outcomes.
2. **Data sharing** — Anonymized outcomes are broadcast to the swarm.
3. **Aggregation** — Peers aggregate shared outcomes into a shared strategy model.
4. **Strategy selection** — Meters select strategies based on collective evidence weighted by local conditions.
5. **Exploration** — A small fraction of meters explore alternative strategies to prevent stagnation.

### Strategy Model

The collective strategy model maps `(conditions, strategy)` pairs to expected outcomes. It is maintained as a distributed, eventually-consistent structure:

- Each meter holds a local replica
- Updates propagate via gossip protocol
- Conflicts resolved by weighted confidence (more observations = higher weight)
- Stale entries decay over time to favor recent evidence

### Learning Parameters

| Parameter | Default | Description |
|-----------|---------|-------------|
| `learning_rate` | 0.1 | Weight of new observations |
| `exploration_rate` | 0.05 | Fraction of exploratory actions |
| `decay_factor` | 0.99 | Per-cycle decay of stale entries |
| `min_confidence` | 0.6 | Threshold to adopt a strategy |

## Emergent Load Balancing

Load balancing emerges without central control through local decisions:

1. **Load signaling** — Meters broadcast anonymized utilization levels.
2. **Neighbor awareness** — Each meter observes the load of nearby peers.
3. **Local redistribution** — Overloaded meters defer work; underloaded meters accept more.
4. **Feedback loops** — Redistribution reduces congestion, which is observed and reinforced.

### Emergent Behavior

- **Self-throttling**: Meters near capacity reduce their acceptance rate.
- **Opportunistic absorption**: Idle meters increase their acceptance rate.
- **Oscillation damping**: Meters apply hysteresis to avoid rapid switching.
- **Cluster formation**: Meters with similar conditions naturally synchronize behavior.

No meter has global knowledge; load balancing emerges from these local rules interacting across the swarm.

## Adaptive Response to Network Conditions

The swarm continuously adapts to changing conditions:

- **Congestion detection** — Rising latency and error rates trigger strategy shifts.
- **Peer churn handling** — Meters adjust to peers joining or leaving.
- **Partition tolerance** — Isolated meters continue operating on their local model and reconcile on reconnection.
- **Condition classification** — Meters classify conditions (idle, moderate, congested) and select strategies accordingly.

### Adaptation Cycle

```
Observe → Share → Aggregate → Select → Act → Evaluate → (repeat)
```

Each cycle runs on a configurable interval (default: 30 seconds).

## Swarm API Endpoints

### Publish Performance Data

```
POST /api/swarm/metrics
```

Publishes anonymized performance data to the swarm.

**Request body:**
```json
{
  "metrics": { "throughput": 0.87, "latency_ms": 42 },
  "strategy": "adaptive_backoff_v2",
  "conditions": "moderate_congestion",
  "outcome": "positive"
}
```

**Response:** `202 Accepted`

### Retrieve Collective Strategy Model

```
GET /api/swarm/strategies
```

Returns the aggregated collective strategy model.

**Response:**
```json
{
  "strategies": [
    {
      "name": "adaptive_backoff_v2",
      "conditions": "moderate_congestion",
      "expected_outcome": 0.82,
      "confidence": 0.91,
      "observations": 1420
    }
  ]
}
```

### Report Local Load

```
POST /api/swarm/load
```

Broadcasts anonymized load indicators.

**Request body:**
```json
{
  "utilization": 0.63,
  "queue_depth": 12,
  "capacity_headroom": 0.37
}
```

**Response:** `202 Accepted`

### Query Swarm Status

```
GET /api/swarm/status
```

Returns swarm health and participation statistics.

**Response:**
```json
{
  "peers": 48,
  "active_strategies": 3,
  "last_sync": "2024-01-15T10:30:00Z",
  "convergence": 0.87
}
```

### Configure Swarm Parameters

```
PUT /api/swarm/config
```

Updates local swarm participation parameters.

**Request body:**
```json
{
  "learning_rate": 0.1,
  "exploration_rate": 0.05,
  "cycle_interval_seconds": 30
}
```

**Response:** `200 OK`

## Testing Swarm Behavior

Swarm behavior is validated through:

- **Unit tests** — Anonymization, aggregation, and strategy selection logic
- **Simulation tests** — Multi-meter simulations verifying emergent load balancing
- **Convergence tests** — Ensuring collective learning converges to optimal strategies
- **Partition tests** — Verifying graceful degradation and reconciliation

See `tests/swarm/` for the test suite.

## Security and Privacy

- All shared data is anonymized and differentially private
- Swarm messages are signed with ephemeral keys
- No persistent identity is required to participate
- Meters may opt out of data sharing while still consuming collective intelligence

## Configuration Reference

| Option | Default | Description |
|--------|---------|-------------|
| `swarm.enabled` | `true` | Enable swarm participation |
| `swarm.share_metrics` | `true` | Share anonymized metrics |
| `swarm.cycle_interval_seconds` | `30` | Adaptation cycle interval |
| `swarm.learning_rate` | `0.1` | Learning rate |
| `swarm.exploration_rate` | `0.05` | Exploration fraction |
| `swarm.decay_factor` | `0.99` | Stale entry decay |
| `swarm.min_confidence` | `0.6` | Strategy adoption threshold |