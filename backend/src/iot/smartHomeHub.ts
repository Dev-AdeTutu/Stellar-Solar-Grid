export interface SmartCircuit {
  circuitId: string;
  name: string;
  isOn: boolean;
  powerWatts: number;
  priority: 'ESSENTIAL' | 'NON_ESSENTIAL' | 'EV_CHARGER';
}

export interface DemandResponseEnrollment {
  enrolled: boolean;
  /** Circuits the user allows to be curtailed during DR events */
  curtailableCircuitIds: string[];
  /** Maximum load the user is willing to shed, in watts */
  maxCurtailmentWatts: number;
}

export interface ActiveDemandResponseEvent {
  eventId: string;
  curtailmentTargetWatts: number;
  startedAt: string;
  endsAt: string;
  /** Watts actually curtailed so far */
  curtailedWatts: number;
  /** Circuit IDs that were shed for this event */
  shedCircuitIds: string[];
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
  demandResponse?: DemandResponseEnrollment;
  activeDemandResponseEvent?: ActiveDemandResponseEvent | null;
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
   * Record a user's demand response enrollment and load preferences
   */
  public setDemandResponseEnrollment(
    meterId: string,
    enrollment: DemandResponseEnrollment,
  ): DemandResponseEnrollment {
    const device = this.devices.get(meterId);
    if (!device) {
      throw new Error(`Meter ${meterId} not found`);
    }
    const knownCircuitIds = new Set(device.circuits.map((c) => c.circuitId));
    for (const circuitId of enrollment.curtailableCircuitIds) {
      if (!knownCircuitIds.has(circuitId)) {
        throw new Error(`Circuit ${circuitId} not found on meter ${meterId}`);
      }
    }
    device.demandResponse = {
      enrolled: enrollment.enrolled,
      curtailableCircuitIds: [...enrollment.curtailableCircuitIds],
      maxCurtailmentWatts: Math.max(0, enrollment.maxCurtailmentWatts),
    };
    return device.demandResponse;
  }

  /**
   * Apply a demand response curtailment command to the meter's non-essential circuits,
   * honoring the user's enrollment and load preferences. Returns the active DR event state.
   */
  public applyDemandResponseCurtailment(
    meterId: string,
    event: { eventId: string; curtailmentTargetWatts: number; startedAt: string; endsAt: string },
  ): ActiveDemandResponseEvent {
    const device = this.devices.get(meterId);
    if (!device) {
      throw new Error(`Meter ${meterId} not found`);
    }
    const enrollment = device.demandResponse;
    if (!enrollment || !enrollment.enrolled) {
      throw new Error(`Meter ${meterId} is not enrolled in demand response`);
    }

    const allowed = new Set(enrollment.curtailableCircuitIds);
    const target = Math.max(0, event.curtailmentTargetWatts);
    const cap = enrollment.maxCurtailmentWatts > 0 ? enrollment.maxCurtailmentWatts : target;
    const effectiveTarget = Math.min(target, cap);

    const shedCircuitIds: string[] = [];
    let curtailedWatts = 0;

    // Shed eligible circuits, lowest priority value first (EV charger, then non-essential)
    const candidates = device.circuits
      .filter(
        (c) =>
          c.isOn &&
          c.priority !== 'ESSENTIAL' &&
          allowed.has(c.circuitId) &&
          curtailedWatts < effectiveTarget,
      )
      .sort((a, b) => b.powerWatts - a.powerWatts);

    for (const circuit of candidates) {
      if (curtailedWatts >= effectiveTarget) break;
      circuit.isOn = false;
      shedCircuitIds.push(circuit.circuitId);
      curtailedWatts += circuit.powerWatts;
    }

    const activeEvent: ActiveDemandResponseEvent = {
      eventId: event.eventId,
      curtailmentTargetWatts: effectiveTarget,
      startedAt: event.startedAt,
      endsAt: event.endsAt,
      curtailedWatts,
      shedCircuitIds,
    };
    device.activeDemandResponseEvent = activeEvent;
    return activeEvent;
  }

  /**
   * End the active demand response event and restore shed circuits
   */
  public endDemandResponseEvent(meterId: string): ActiveDemandResponseEvent | null {
    const device = this.devices.get(meterId);
    if (!device) {
      throw new Error(`Meter ${meterId} not found`);
    }
    const activeEvent = device.activeDemandResponseEvent ?? null;
    if (activeEvent) {
      for (const circuitId of activeEvent.shedCircuitIds) {
        const circuit = device.circuits.find((c) => c.circuitId === circuitId);
        if (circuit) {
          circuit.isOn = true;
        }
      }
    }
    device.activeDemandResponseEvent = null;
    return activeEvent;
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
      demandResponse: device.demandResponse ?? { enrolled: false, curtailableCircuitIds: [], maxCurtailmentWatts: 0 },
      activeDemandResponseEvent: device.activeDemandResponseEvent ?? null,
    };
  }
}

export const smartHomeIoTHub = new SmartHomeIoTHub();
