# Meter Virtual Twin Simulation (#1010)

## Overview

The Meter Virtual Twin Simulation system provides a digital twin that emulates physical IoT smart meter behavior without requiring deployment to hardware. It enables safe validation of smart contract rule changes, fault injection testing, weather impact modeling, and interactive technician training.

## Features

1. **IoT Meter Emulation**: Mimics voltage, current, net grid draw, solar generation, and physical contactor relay state across `residential`, `commercial`, `industrial`, and `solar_prosumer` usage patterns.
2. **Weather & Fault Injection**: Simulates `sunny`, `partly_cloudy`, `overcast`, `storm`, and `heatwave` weather conditions alongside hardware faults (`voltage_sag`, `relay_stuck_open`, `relay_stuck_closed`, `tamper_detected`, `comms_dropout`, `lightning_surge`).
3. **Contract Rule Testing**: Tests changes to `unitPriceStroops`, `dailyLimitUnits`, payment plans, and `autoDeactivate` behavior over 24–168 simulated hours.
4. **Technician Training Environment**: Provides pre-configured field troubleshooting scenarios (`/api/simulation/training-scenarios`) for diagnosing stuck relays, tamper bypasses, and lightning surge arrestor failures.
5. **Frontend Control Panel**: Available at `/simulation` (`frontend/src/app/simulation/page.tsx`).

## API Endpoints

### `POST /api/simulation/create`

Creates a new virtual meter twin.

```json
{
  "id": "V-METER-101",
  "usagePattern": "residential",
  "weather": "sunny",
  "fault": "none",
  "balanceStroops": 5000,
  "trainingMode": true,
  "contractRules": {
    "unitPriceStroops": 10,
    "dailyLimitUnits": 500,
    "plan": "UsageBased",
    "autoDeactivate": true
  }
}
```

### `POST /api/simulation/meters/:id/step`

Advances the virtual meter by one simulated hour and returns the emitted telemetry frame and updated meter state.

### `POST /api/simulation/meters/:id/scenario`

Runs a multi-hour scenario against the virtual meter and returns aggregated consumption, final balance, contract deactivation status, and hourly telemetry trace.

### `GET /api/simulation/training-scenarios`

Lists built-in technician training scenarios with expected diagnoses and recommended remediation steps.
