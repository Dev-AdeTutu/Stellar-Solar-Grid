import { SmartHomeIoTHub } from '../src/iot/smartHomeHub';

describe('Smart Home Integration IoT Hub (#1014)', () => {
  const createHubWithSampleDevice = () => {
    const hub = new SmartHomeIoTHub();
    hub.exposeMeterDevice({
      meterId: 'MTR-HOME-01',
      manufacturer: 'Stellar Solar Grid',
      model: 'SSG-SmartMeter-v2',
      swVersion: '2.1.0',
      solarGenerationWatts: 5200,
      gridImportWatts: 300,
      dailyEnergyKwh: 29.5,
      batterySocPercent: 18,
      circuits: [
        { circuitId: 'ev_charger', name: 'EV Charger', isOn: true, powerWatts: 6600, priority: 'EV_CHARGER' },
        { circuitId: 'hvac', name: 'HVAC Unit', isOn: false, powerWatts: 1800, priority: 'NON_ESSENTIAL' },
      ],
    });
    return hub;
  };

  test('generates Home Assistant MQTT auto-discovery topics for energy sensors and circuits', () => {
    const hub = createHubWithSampleDevice();
    const discovery = hub.buildHomeAssistantMqttDiscovery('MTR-HOME-01');

    expect(discovery.length).toBe(4);
    expect(discovery[0].topic).toContain('homeassistant/sensor/stellar_MTR-HOME-01/energy_kwh/config');
    expect(discovery[2].topic).toContain('homeassistant/switch/stellar_MTR-HOME-01/ev_charger/config');
  });

  test('controls circuits via Google Home and Alexa directives', () => {
    const hub = createHubWithSampleDevice();
    const response = hub.handleVoiceAssistantDirective({
      platform: 'GOOGLE_HOME',
      intent: 'EXECUTE',
      deviceId: 'MTR-HOME-01',
      circuitId: 'hvac',
      command: 'TurnOn',
    });

    const hvac = response.circuits?.find((c) => c.circuitId === 'hvac');
    expect(hvac?.isOn).toBe(true);
  });

  test('executes smart home automations based on battery and solar thresholds', () => {
    const hub = createHubWithSampleDevice();
    hub.registerAutomation({
      ruleId: 'SHED-EV-ON-LOW-BATTERY',
      name: 'Turn off EV charger when battery SoC <= 20%',
      condition: 'LOW_BATTERY',
      thresholdValue: 20,
      targetCircuitId: 'ev_charger',
      action: 'TURN_OFF',
    });

    const triggered = hub.evaluateAutomations('MTR-HOME-01');
    expect(triggered).toContain('SHED-EV-ON-LOW-BATTERY');

    const telemetry = hub.getDashboardTelemetry('MTR-HOME-01');
    const ev = telemetry.circuits.find((c) => c.circuitId === 'ev_charger');
    expect(ev?.isOn).toBe(false);
  });
});
