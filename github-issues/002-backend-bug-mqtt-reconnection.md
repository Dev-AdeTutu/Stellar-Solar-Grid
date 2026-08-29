---
name: Bug Report
about: Report a reproducible bug in Stellar SolarGrid
title: "[Bug] MQTT client doesn't reconnect after broker restart"
labels: bug
assignees: ''
---

## Describe the Bug

The IoT Bridge loses connection to the MQTT broker when the broker restarts and does not automatically reconnect. This causes usage updates from smart meters to be lost until the backend service is manually restarted.

## Steps to Reproduce

1. Start the full stack with `docker compose up`
2. Verify MQTT connection is active
3. Restart the MQTT broker: `docker compose restart mqtt`
4. Publish a test message from a meter
5. Observe that the backend does not receive the message

## Expected Behavior

The MQTT client should automatically reconnect to the broker when the connection is lost, with exponential backoff retry logic.

## Actual Behavior

Connection remains closed. Logs show no reconnection attempts. The bridge service must be restarted manually to restore functionality.

## Screenshots / Logs

```
[ERROR] MQTT connection lost: Connection refused
[WARN] Usage update from METER1 failed: Not connected
```

## Environment

| Field | Value |
|-------|-------|
| Component | backend |
| OS | Ubuntu 22.04 (Docker) |
| Node.js version | 20.14.2 |
| MQTT library | mqtt@5.7.0 |
| Network | testnet |

## Additional Context

The `mqttClient.ts` file likely needs to implement reconnection logic with the `reconnectPeriod` option and proper event handlers for `close` and `offline` events.
