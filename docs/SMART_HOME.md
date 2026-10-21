# Smart Home Integration (IoT Hub)

## Overview

The Stellar Solar Grid Smart Home IoT Hub (`backend/src/iot/smartHomeHub.ts`) exposes smart solar meters and sub-circuits to popular home automation platforms including **Home Assistant**, **Google Home**, and **Amazon Alexa**.

## Features

1. **Home Assistant MQTT Auto-Discovery**:
   - Automatically publishes discovery payloads to `homeassistant/sensor/stellar_<meterId>/...` and `homeassistant/switch/stellar_<meterId>/...`.
   - Exposes `dailyEnergyKwh` (`device_class: energy`, `state_class: total_increasing`) and `solarGenerationWatts` (`device_class: power`) for direct integration with the Home Assistant Energy Dashboard.

2. **Google Home & Amazon Alexa Device Control**:
   - Processes `SYNC`, `QUERY`, and `EXECUTE` intents via `handleVoiceAssistantDirective`.
   - Allows voice commands such as *"Hey Google, turn off the EV Charger circuit"* or *"Alexa, check my solar meter energy"*.

3. **Smart Circuit Automations**:
   - Supports automated load shedding and solar surplus routing (`registerAutomation`, `evaluateAutomations`):
     - `LOW_BATTERY`: Automatically turns off non-essential or EV circuits when battery SoC drops below threshold.
     - `HIGH_SOLAR_SURPLUS`: Automatically activates water heaters or EV chargers during peak solar production.

## Configuration

### Home Assistant (`configuration.yaml`)
Ensure MQTT discovery is enabled in your Home Assistant instance:

```yaml
mqtt:
  broker: mqtt.stellarsolargrid.local
  port: 1883
  discovery: true
  discovery_prefix: homeassistant
```

### Environment Variables
```env
MQTT_BROKER_URL=mqtt://localhost:1883
SMART_HOME_HUB_ENABLED=true
GOOGLE_HOME_PROJECT_ID=stellar-solar-smart-home
ALEXA_SKILL_ID=amzn1.ask.skill.stellar-solar-grid
```
