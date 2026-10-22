/**
 * Meter Virtual Twin Simulation Engine (#1010)
 *
 * Digital twin that emulates physical IoT meter behavior for testing and training:
 * - Simulates residential/commercial/industrial usage patterns
 * - Injects hardware/grid faults (tamper, relay stuck, voltage sag, comms drop, lightning surge)
 * - Models weather impacts on solar generation and load
 * - Tests contract rule changes (unit price, daily limits, payment plans, auto-deactivate)
 * - Provides interactive training scenarios for field technicians
 */

export type UsagePatternType = "residential" | "commercial" | "industrial" | "solar_prosumer";
export type WeatherCondition = "sunny" | "partly_cloudy" | "overcast" | "storm" | "heatwave";
export type FaultType =
  | "none"
  | "voltage_sag"
  | "relay_stuck_open"
  | "relay_stuck_closed"
  | "tamper_detected"
  | "comms_dropout"
  | "lightning_surge";

export interface VirtualMeterTelemetry {
  timestamp: string;
  hourOfDay: number;
  voltageV: number;
  currentA: number;
  powerKw: number;
  solarGenerationKw: number;
  netGridKw: number;
  unitsUsedDelta: number;
  temperatureC: number;
  faultActive: FaultType;
  relayClosed: boolean;
}

export interface ContractRuleSimulation {
  unitPriceStroops: number;
  dailyLimitUnits: number;
  plan: "Daily" | "Weekly" | "Monthly" | "UsageBased";
  autoDeactivate: boolean;
}

export interface VirtualMeterTwin {
  id: string;
  name: string;
  owner: string;
  firmwareVersion: string;
  usagePattern: UsagePatternType;
  weather: WeatherCondition;
  fault: FaultType;
  active: boolean;
  relayClosed: boolean;
  balanceStroops: number;
  unitsUsed: number;
  daySpentUnits: number;
  contractRules: ContractRuleSimulation;
  trainingMode: boolean;
  trainingScenarioId?: string;
  telemetryHistory: VirtualMeterTelemetry[];
  createdAt: string;
  updatedAt: string;
}

export interface CreateVirtualTwinInput {
  id?: string;
  name?: string;
  owner?: string;
  usagePattern?: UsagePatternType;
  weather?: WeatherCondition;
  fault?: FaultType;
  balanceStroops?: number;
  trainingMode?: boolean;
  trainingScenarioId?: string;
  contractRules?: Partial<ContractRuleSimulation>;
}

export interface ContractTestResult {
  meterId: string;
  simulatedHours: number;
  initialBalanceStroops: number;
  finalBalanceStroops: number;
  totalUnitsConsumed: number;
  totalCostStroops: number;
  deactivatedByContract: boolean;
  dailyLimitBreached: boolean;
  faultsEncountered: FaultType[];
  hourlyTrace: VirtualMeterTelemetry[];
}

export interface TechnicianTrainingScenario {
  id: string;
  title: string;
  difficulty: "beginner" | "intermediate" | "advanced";
  description: string;
  initialFault: FaultType;
  weather: WeatherCondition;
  expectedDiagnosis: string;
  recommendedAction: string;
}

const virtualMeters = new Map<string, VirtualMeterTwin>();

export const TRAINING_SCENARIOS: TechnicianTrainingScenario[] = [
  {
    id: "train-relay-stuck",
    title: "Stuck Contactor Relay After Balance Exhaustion",
    difficulty: "beginner",
    description:
      "Meter balance reached 0 and contract emitted mtr_deact, but physical load continues drawing current.",
    initialFault: "relay_stuck_closed",
    weather: "sunny",
    expectedDiagnosis: "Welded contactor relay contacts keeping load energized",
    recommendedAction: "Isolate breaker, replace relay module, and run relay cycle verification.",
  },
  {
    id: "train-tamper-bypass",
    title: "Magnetic Tamper & Neutral Bypass Alert",
    difficulty: "intermediate",
    description:
      "Enclosure tamper reed switch triggered with abnormal voltage-to-current phase imbalance.",
    initialFault: "tamper_detected",
    weather: "partly_cloudy",
    expectedDiagnosis: "Physical enclosure breach and line-load bypass attempt",
    recommendedAction: "Inspect terminal seal, clear tamper latch, and audit usage discrepancy.",
  },
  {
    id: "train-storm-surge",
    title: "Lightning Surge & Undervoltage Brownout",
    difficulty: "advanced",
    description:
      "Severe storm caused transient overvoltage followed by persistent grid voltage sag below 190V.",
    initialFault: "voltage_sag",
    weather: "storm",
    expectedDiagnosis: "MOV surge arrestor degradation and transformer tap brownout",
    recommendedAction: "Verify MOV arrestor continuity, file meter insurance claim if damaged.",
  },
];

function weatherSolarMultiplier(weather: WeatherCondition): number {
  switch (weather) {
    case "sunny":
      return 1.0;
    case "heatwave":
      return 0.92; // thermal derating
    case "partly_cloudy":
      return 0.65;
    case "overcast":
      return 0.25;
    case "storm":
      return 0.08;
  }
}

function weatherLoadMultiplier(weather: WeatherCondition): number {
  switch (weather) {
    case "heatwave":
      return 1.45; // heavy AC load
    case "storm":
      return 1.15;
    default:
      return 1.0;
  }
}

function basePatternKw(pattern: UsagePatternType, hour: number): number {
  if (pattern === "residential") {
    if (hour >= 18 && hour <= 22) return 2.8;
    if (hour >= 6 && hour <= 9) return 1.9;
    return 0.7;
  }
  if (pattern === "commercial") {
    if (hour >= 8 && hour <= 18) return 6.5;
    return 1.2;
  }
  if (pattern === "industrial") {
    return hour >= 6 && hour <= 22 ? 14.0 : 8.5;
  }
  // solar_prosumer
  if (hour >= 18 && hour <= 21) return 2.4;
  return 1.0;
}

/**
 * Create and register a new virtual meter twin (#1010).
 */
export function createVirtualMeter(input: CreateVirtualTwinInput = {}): VirtualMeterTwin {
  const id = input.id?.trim() || `V-METER-${virtualMeters.size + 101}`;
  const now = new Date().toISOString();
  const scenario = input.trainingScenarioId
    ? TRAINING_SCENARIOS.find((s) => s.id === input.trainingScenarioId)
    : undefined;

  const fault = input.fault ?? scenario?.initialFault ?? "none";
  const weather = input.weather ?? scenario?.weather ?? "sunny";
  const balanceStroops = input.balanceStroops ?? 5_000;
  const active = balanceStroops > 0 && fault !== "lightning_surge";

  const twin: VirtualMeterTwin = {
    id,
    name: input.name ?? `Virtual Twin ${id}`,
    owner: input.owner ?? "GVIRTUALTWINOWNER1111111111111111111111111111111111111",
    firmwareVersion: "2.4.0-sim",
    usagePattern: input.usagePattern ?? "residential",
    weather,
    fault,
    active,
    relayClosed: fault === "relay_stuck_open" ? false : fault === "relay_stuck_closed" ? true : active,
    balanceStroops,
    unitsUsed: 0,
    daySpentUnits: 0,
    contractRules: {
      unitPriceStroops: input.contractRules?.unitPriceStroops ?? 10,
      dailyLimitUnits: input.contractRules?.dailyLimitUnits ?? 500,
      plan: input.contractRules?.plan ?? "UsageBased",
      autoDeactivate: input.contractRules?.autoDeactivate ?? true,
    },
    trainingMode: Boolean(input.trainingMode || scenario),
    trainingScenarioId: scenario?.id ?? input.trainingScenarioId,
    telemetryHistory: [],
    createdAt: now,
    updatedAt: now,
  };

  virtualMeters.set(id, twin);
  return twin;
}

/**
 * Step a virtual meter forward by one simulated hour (`hourOfDay` 0..23).
 */
export function stepVirtualMeter(meterId: string, hourOfDay = 12): VirtualMeterTelemetry {
  const twin = virtualMeters.get(meterId);
  if (!twin) {
    throw new Error(`Virtual meter ${meterId} not found`);
  }

  const solarMult = weatherSolarMultiplier(twin.weather);
  const loadMult = weatherLoadMultiplier(twin.weather);

  let solarKw = 0;
  if (hourOfDay >= 6 && hourOfDay <= 18) {
    solarKw = Number((Math.sin(((hourOfDay - 6) / 12) * Math.PI) * 4.0 * solarMult).toFixed(2));
  }

  let voltageV = 230;
  if (twin.fault === "voltage_sag") voltageV = 182;
  else if (twin.fault === "lightning_surge") voltageV = 410;

  // Relay state calculation based on contract state + hardware fault
  if (twin.fault === "relay_stuck_open") {
    twin.relayClosed = false;
  } else if (twin.fault === "relay_stuck_closed") {
    twin.relayClosed = true;
  } else {
    twin.relayClosed = twin.active;
  }

  const rawDemandKw = basePatternKw(twin.usagePattern, hourOfDay) * loadMult;
  const effectiveDemandKw = twin.relayClosed ? Number(rawDemandKw.toFixed(2)) : 0;
  const netGridKw = Number(Math.max(0, effectiveDemandKw - solarKw).toFixed(2));
  const currentA = voltageV > 0 ? Number(((effectiveDemandKw * 1000) / voltageV).toFixed(2)) : 0;
  const unitsDelta = Math.round(netGridKw * 10); // 10 units per kWh

  // Apply contract rules
  const costStroops = unitsDelta * twin.contractRules.unitPriceStroops;
  twin.unitsUsed += unitsDelta;
  twin.daySpentUnits += unitsDelta;
  twin.balanceStroops = Math.max(0, twin.balanceStroops - costStroops);

  if (
    twin.contractRules.dailyLimitUnits > 0 &&
    twin.daySpentUnits >= twin.contractRules.dailyLimitUnits &&
    twin.contractRules.autoDeactivate
  ) {
    twin.active = false;
  }
  if (twin.balanceStroops <= 0 && twin.contractRules.autoDeactivate) {
    twin.active = false;
  }
  if (twin.fault === "relay_stuck_closed") {
    twin.relayClosed = true;
  } else if (twin.fault !== "relay_stuck_open") {
    twin.relayClosed = twin.active;
  }

  const telemetry: VirtualMeterTelemetry = {
    timestamp: new Date().toISOString(),
    hourOfDay,
    voltageV,
    currentA,
    powerKw: effectiveDemandKw,
    solarGenerationKw: solarKw,
    netGridKw,
    unitsUsedDelta: unitsDelta,
    temperatureC: twin.weather === "heatwave" ? 41 : twin.weather === "storm" ? 19 : 26,
    faultActive: twin.fault,
    relayClosed: twin.relayClosed,
  };

  twin.telemetryHistory.push(telemetry);
  if (twin.telemetryHistory.length > 96) {
    twin.telemetryHistory.shift();
  }
  twin.updatedAt = telemetry.timestamp;

  return telemetry;
}

/**
 * Simulate a multi-hour scenario and test contract rule changes against a virtual meter.
 */
export function runContractScenarioSimulation(
  meterId: string,
  options: {
    hours?: number;
    weather?: WeatherCondition;
    fault?: FaultType;
    contractRules?: Partial<ContractRuleSimulation>;
  } = {},
): ContractTestResult {
  const twin = virtualMeters.get(meterId);
  if (!twin) {
    throw new Error(`Virtual meter ${meterId} not found`);
  }

  if (options.weather) twin.weather = options.weather;
  if (options.fault) twin.fault = options.fault;
  if (options.contractRules) {
    twin.contractRules = { ...twin.contractRules, ...options.contractRules };
  }

  const hours = Math.min(Math.max(options.hours ?? 24, 1), 168);
  const initialBalanceStroops = twin.balanceStroops;
  const initialUnits = twin.unitsUsed;
  const hourlyTrace: VirtualMeterTelemetry[] = [];
  const faultsEncountered = new Set<FaultType>();

  for (let i = 0; i < hours; i++) {
    const t = stepVirtualMeter(meterId, i % 24);
    hourlyTrace.push(t);
    if (t.faultActive !== "none") {
      faultsEncountered.add(t.faultActive);
    }
  }

  const totalUnitsConsumed = twin.unitsUsed - initialUnits;
  const totalCostStroops = initialBalanceStroops - twin.balanceStroops;
  const dailyLimitBreached =
    twin.contractRules.dailyLimitUnits > 0 &&
    twin.daySpentUnits >= twin.contractRules.dailyLimitUnits;

  return {
    meterId,
    simulatedHours: hours,
    initialBalanceStroops,
    finalBalanceStroops: twin.balanceStroops,
    totalUnitsConsumed,
    totalCostStroops,
    deactivatedByContract: !twin.active,
    dailyLimitBreached,
    faultsEncountered: Array.from(faultsEncountered),
    hourlyTrace,
  };
}

export function getVirtualMeter(meterId: string): VirtualMeterTwin | undefined {
  return virtualMeters.get(meterId);
}

export function listVirtualMeters(): VirtualMeterTwin[] {
  return Array.from(virtualMeters.values());
}

export function clearVirtualMeters(): void {
  virtualMeters.clear();
}
