export interface SmartCircuit {
  circuitId: string;
  name: string;
  isOn: boolean;
  powerWatts: number;
  priority: 'ESSENTIAL' | 'NON_ESSENTIAL' | 'EV_CHARGER';
}

export interface SmartMeterDeviceState {
  meterId: string;
  manufacturer: string;
  model: string;
  swVersion: string;
  solarGenerationWatts: number;
  gridImportWatts: number;
  dailyEnergyKwh: number;
  batterySocPercent: number;
  circuits: SmartCircuit[];
}

export interface MqttDiscoveryPayload {
  topic: string;
  payload: Record<string, unknown>;
  retain: boolean;
}

export interface VoiceAssistantDirective {
  platform: 'GOOGLE_HOME' | 'ALEXA';
  intent: 'SYNC' | 'QUERY' | 'EXECUTE';
  deviceId: string;
  circuitId?: string;
  command?: 'TurnOn' | 'TurnOff' | 'SetLoadShedding';
}

export interface AutomationRule {
  ruleId: string;
  name: string;
  condition: 'LOW_BATTERY' | 'HIGH_SOLAR_SURPLUS' | 'PEAK_TARIFF';
  thresholdValue: number;
  targetCircuitId: string;
  action: 'TURN_ON' | 'TURN_OFF';
}

export class SmartHomeIoTHub {
  private devices = new Map<string, SmartMeterDeviceState>();
  private automations: AutomationRule[] = [];

  /**
   * Register and expose a Stellar Solar Grid meter as a Smart Home IoT device
   */
  public exposeMeterDevice(state: SmartMeterDeviceState): SmartMeterDeviceState {
    this.devices.set(state.meterId, state);
    return state;
  }

  /**
   * Generate Home Assistant MQTT Auto-Discovery configurations for energy dashboard & relay switches
   */
  public buildHomeAssistantMqttDiscovery(meterId: string): MqttDiscoveryPayload[] {
    const device = this.devices.get(meterId);
    if (!device) {
      throw new Error(`Meter ${meterId} is not registered in Smart Home Hub`);
    }

    const baseDeviceMeta = {
      identifiers: [`stellar_solar_${device.meterId}`],
      name: `Stellar Solar Meter ${device.meterId}`,
      manufacturer: device.manufacturer,
      model: device.model,
      sw_version: device.swVersion,
    };

    const payloads: MqttDiscoveryPayload[] = [
      {
        topic: `homeassistant/sensor/stellar_${meterId}/energy_kwh/config`,
        retain: true,
        payload: {
          name: 'Daily Solar Grid Energy',
          unique_id: `stellar_${meterId}_daily_energy`,
          state_topic: `stellar/${meterId}/telemetry/state`,
          unit_of_measurement: 'kWh',
          device_class: 'energy',
          state_class: 'total_increasing',
          value_template: '{{ value_json.dailyEnergyKwh }}',
          device: baseDeviceMeta,
        },
      },
      {
        topic: `homeassistant/sensor/stellar_${meterId}/solar_power/config`,
        retain: true,
        payload: {
          name: 'Solar Generation Power',
          unique_id: `stellar_${meterId}_solar_power`,
          state_topic: `stellar/${meterId}/telemetry/state`,
          unit_of_measurement: 'W',
          device_class: 'power',
          state_class: 'measurement',
          value_template: '{{ value_json.solarGenerationWatts }}',
          device: baseDeviceMeta,
        },
      },
    ];

    for (const circuit of device.circuits) {
      payloads.push({
        topic: `homeassistant/switch/stellar_${meterId}/${circuit.circuitId}/config`,
        retain: true,
        payload: {
          name: `Circuit ${circuit.name}`,
          unique_id: `stellar_${meterId}_circuit_${circuit.circuitId}`,
          state_topic: `stellar/${meterId}/circuit/${circuit.circuitId}/state`,
          command_topic: `stellar/${meterId}/circuit/${circuit.circuitId}/set`,
          payload_on: 'ON',
          payload_off: 'OFF',
          device: baseDeviceMeta,
        },
      });
    }

    return payloads;
  }

  /**
   * Handle Google Home Smart Home / Amazon Alexa SmartHome Skill directives
   */
  public handleVoiceAssistantDirective(directive: VoiceAssistantDirective) {
    const device = this.devices.get(directive.deviceId);
    if (!device) {
      throw new Error(`Device ${directive.deviceId} not found`);
    }

    if (directive.intent === 'SYNC') {
      return {
        platform: directive.platform,
        deviceId: device.meterId,
        type: 'action.devices.types.SENSOR',
        traits: ['action.devices.traits.OnOff', 'action.devices.traits.EnergyStorage'],
        circuits: device.circuits.map((c) => ({ id: c.circuitId, name: c.name })),
      };
    }

    if (directive.intent === 'EXECUTE' && directive.circuitId) {
      const turnOn = directive.command === 'TurnOn';
      this.setCircuitState(device.meterId, directive.circuitId, turnOn);
    }

    return {
      platform: directive.platform,
      deviceId: device.meterId,
      online: true,
      solarGenerationWatts: device.solarGenerationWatts,
      dailyEnergyKwh: device.dailyEnergyKwh,
      batterySocPercent: device.batterySocPercent,
      circuits: device.circuits,
    };
  }

  /**
   * Toggle a physical load circuit on the smart meter
   */
  public setCircuitState(meterId: string, circuitId: string, isOn: boolean): SmartCircuit {
    const device = this.devices.get(meterId);
    if (!device) {
      throw new Error(`Meter ${meterId} not found`);
    }
    const circuit = device.circuits.find((c) => c.circuitId === circuitId);
    if (!circuit) {
      throw new Error(`Circuit ${circuitId} not found on meter ${meterId}`);
    }
    circuit.isOn = isOn;
    return circuit;
  }

  /**
   * Register and evaluate smart home automation rules to control circuits dynamically
   */
  public registerAutomation(rule: AutomationRule): void {
    this.automations.push(rule);
  }

  public evaluateAutomations(meterId: string): string[] {
    const device = this.devices.get(meterId);
    if (!device) return [];

    const executedRules: string[] = [];
    for (const rule of this.automations) {
      let triggered = false;
      if (rule.condition === 'LOW_BATTERY' && device.batterySocPercent <= rule.thresholdValue) {
        triggered = true;
      } else if (
        rule.condition === 'HIGH_SOLAR_SURPLUS' &&
        device.solarGenerationWatts >= rule.thresholdValue
      ) {
        triggered = true;
      }

      if (triggered) {
        this.setCircuitState(meterId, rule.targetCircuitId, rule.action === 'TURN_ON');
        executedRules.push(rule.ruleId);
      }
    }
    return executedRules;
  }

  /**
   * Export real-time energy metrics formatted for Smart Home Energy Dashboards
   */
  public getDashboardTelemetry(meterId: string) {
    const device = this.devices.get(meterId);
    if (!device) {
      throw new Error(`Meter ${meterId} not found`);
    }
    return {
      meterId: device.meterId,
      solarGenerationWatts: device.solarGenerationWatts,
      gridImportWatts: device.gridImportWatts,
      dailyEnergyKwh: device.dailyEnergyKwh,
      batterySocPercent: device.batterySocPercent,
      activeCircuits: device.circuits.filter((c) => c.isOn).length,
      circuits: device.circuits,
    };
  }
}

export const smartHomeIoTHub = new SmartHomeIoTHub();
