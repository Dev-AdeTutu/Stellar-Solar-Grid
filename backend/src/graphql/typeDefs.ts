/**
 * GraphQL schema (SDL) for the SolarGrid API (#898).
 *
 * Kept free of runtime imports so `npm run docs:graphql` can load it without
 * contract / database configuration. Descriptions ("""...""") feed the
 * generated docs in docs/graphql/.
 */
import { buildSchema } from "graphql";

export const typeDefs = /* GraphQL */ `
  """Arbitrary JSON value (used for pass-through REST payloads and free-form specs)."""
  scalar JSON

  enum HttpMethod { GET POST PUT PATCH DELETE }

  # ── Meters, payments, usage ────────────────────────────────────────────────

  type UsageEvent {
    id: Int!
    meterId: String!
    units: Float!
    cost: String!
    receivedAt: String!
    transactionHash: String
  }

  type UsageHistory {
    events: [UsageEvent!]!
    page: Int!
    pageSize: Int!
    total: Int!
    hasMore: Boolean!
  }

  type MeterBalance { meterId: String!, balance: String!, updatedAt: String! }
  type MeterStatus { meterId: String!, status: String!, updatedAt: String! }

  type Payment {
    txHash: String!
    address: String!
    meterId: String
    amountXlm: Float
    plan: String
    status: String!
    confirmedAt: String!
    date: String
    memo: String
  }

  type UsageUpdate { meterId: String!, units: Float!, cost: String!, updatedAt: String! }

  """A prepaid smart meter registered on-chain."""
  type Meter {
    id: String!
    owner: String!
    active: Boolean!
    unitsUsed: Float!
    plan: String!
    lastPayment: String!
    expiresAt: String!
    dailyLimit: Float
    daySpent: Float
    balance: String
    payments: [Payment!]!
    usageHistory(page: Int = 1, pageSize: Int = 20): UsageHistory!
    """Heartbeat-based health (GET /api/meters/:id/health)."""
    health: MeterHealth
    """Days until the balance runs out (GET /api/meters/:id/prediction)."""
    prediction: Prediction
    """Devices linked to this meter in the device registry."""
    devices: [Device!]!
  }

  enum HealthStatus { green yellow red }

  type MeterHealth {
    meterId: String!
    status: HealthStatus!
    lastHeartbeat: String!
    secondsSinceHeartbeat: Int!
    heartbeatCount: Int!
    errorRate: Float!
    avgResponseTimeMs: Float
    uptimePercent: Float!
  }

  type HealthSummary { green: Int!, yellow: Int!, red: Int! }
  type MeterHealthDashboard { summary: HealthSummary!, meters: [MeterHealth!]! }

  type ConfidenceInterval { low: Float, high: Float, level: Float! }

  type Prediction {
    meterId: String!
    balance: Float!
    estimatedDaysRemaining: Float
    confidenceInterval: ConfidenceInterval!
    avgDailyUsage: Float!
    trendPerDay: Float!
    trainingDays: Int!
    generatedAt: String!
  }

  # ── Solar forecast ─────────────────────────────────────────────────────────

  type ForecastPeriod { period: String!, days: Int!, estimatedKwh: Float!, estimatedRevenue: Float! }
  type SolarForecast {
    panelCapacityKw: Float!
    peakSunHours: Float!
    efficiency: Float!
    panelAgeYears: Float!
    effectiveDegradation: Float!
    dailyKwh: Float!
    forecast: [ForecastPeriod!]!
  }
  type IrradianceZone { name: String!, peakSunHours: Float! }

  # ── Device registry (#897) ─────────────────────────────────────────────────

  enum DeviceType { solar_panel inverter meter }
  enum DeviceStatus { active inactive maintenance decommissioned }

  """A solar panel, inverter or meter in the device registry."""
  type Device {
    id: ID!
    type: DeviceType!
    owner: String!
    manufacturer: String!
    model: String!
    serialNumber: String!
    meterId: String
    location: String
    installedAt: String
    status: DeviceStatus!
    """Spec sheet, e.g. { ratedPowerW, efficiency, latitude, longitude }."""
    specs: JSON!
    createdAt: String!
    updatedAt: String!
    certifications: [Certification!]!
    maintenance: [MaintenanceSchedule!]!
    performance(days: Int = 7): PerformanceSummary!
    performanceReadings(days: Int = 7): [PerformanceReading!]!
    stability(days: Int = 7): StabilityReport!
  }

  type Certification {
    id: ID!
    deviceId: ID!
    standard: String!
    issuer: String!
    certificateNumber: String
    issuedAt: String!
    expiresAt: String
    documentUrl: String
    valid: Boolean!
  }

  type MaintenanceSchedule {
    id: ID!
    deviceId: ID!
    task: String!
    intervalDays: Int!
    lastPerformedAt: String
    nextDueAt: String!
    lastReminderAt: String
    notes: String
  }

  type PerformanceReading {
    deviceId: ID!
    recordedAt: String!
    powerW: Float
    energyKwh: Float
    voltageV: Float
    frequencyHz: Float
    temperatureC: Float
    efficiency: Float
  }

  type PerformanceSummary {
    deviceId: ID!
    readings: Int!
    from: String
    to: String
    totalEnergyKwh: Float!
    avgPowerW: Float
    peakPowerW: Float
    avgEfficiency: Float
    avgTemperatureC: Float
    capacityFactor: Float
  }

  type StabilityAnomaly {
    id: Int!
    deviceId: ID!
    recordedAt: String!
    metric: String!
    value: Float!
    severity: String!
    message: String!
  }

  type StabilityReport {
    deviceId: ID!
    from: String!
    to: String!
    readings: Int!
    stabilityScore: Int
    anomalies: [StabilityAnomaly!]!
  }

  input RegisterDeviceInput {
    type: DeviceType!
    owner: String!
    manufacturer: String!
    model: String!
    serialNumber: String!
    meterId: String
    location: String
    installedAt: String
    specs: JSON
  }

  input UpdateDeviceInput {
    meterId: String
    location: String
    installedAt: String
    status: DeviceStatus
    specs: JSON
  }

  input CertificationInput {
    standard: String!
    issuer: String!
    certificateNumber: String
    issuedAt: String!
    expiresAt: String
    documentUrl: String
  }

  input MaintenanceInput {
    task: String!
    intervalDays: Int!
    nextDueAt: String
    notes: String
  }

  input PerformanceInput {
    recordedAt: String
    powerW: Float
    energyKwh: Float
    voltageV: Float
    frequencyHz: Float
    temperatureC: Float
    efficiency: Float
  }

  # ── Weather (#900) ─────────────────────────────────────────────────────────

  type WeatherLocation { lat: Float!, lon: Float!, timezone: String }

  type WeatherConditions {
    time: String!
    temperatureC: Float!
    cloudCoverPct: Float!
    humidityPct: Float!
    windSpeedMs: Float!
    uvIndex: Float
    conditionId: Int!
    condition: String!
    description: String!
    sunrise: String
    sunset: String
  }

  type DailyForecast {
    date: String!
    tempMinC: Float!
    tempMaxC: Float!
    cloudCoverPct: Float!
    precipitationProbability: Float!
    rainMm: Float!
    windSpeedMs: Float!
    uvIndex: Float
    conditionId: Int!
    condition: String!
    description: String!
    daylightHours: Float
  }

  type WeatherAlert {
    date: String!
    type: String!
    severity: String!
    message: String!
    expectedProductionFactor: Float
  }

  type DailyProductionForecast {
    date: String!
    baselineKwh: Float!
    weatherFactor: Float!
    expectedKwh: Float!
    cloudCoverPct: Float!
    tempMaxC: Float!
    condition: String!
  }

  """Weather for a location. One upstream call backs every field (cached ~30 min)."""
  type Weather {
    location: WeatherLocation!
    current: WeatherConditions!
    forecast(days: Int = 7): [DailyForecast!]!
    alerts: [WeatherAlert!]!
    productionForecast(capacityKw: Float!, peakSunHours: Float = 5, efficiency: Float = 0.2, panelAgeYears: Float = 0): [DailyProductionForecast!]!
    fetchedAt: String!
    stale: Boolean!
  }

  # ── Staking (#899) ─────────────────────────────────────────────────────────

  type StakingStats {
    configured: Boolean!
    stakeToken: String
    rewardToken: String
    rewardRatePerSecond: String!
    cooldownSecs: Int!
    totalStaked: String!
    stakerCount: Int!
    rewardReserve: String!
    totalDistributed: String!
    aprPercent: Float
    reserveRunwayDays: Float
  }

  type StakerInfo {
    address: String!
    staked: String!
    pendingRewards: String!
    unstaking: String!
    unlockAt: String
    canWithdraw: Boolean!
    votingPower: String!
    votingSharePercent: Float
    stakedAt: String
  }

  # ── Generic REST bridge ────────────────────────────────────────────────────

  type RestResponse { status: Int!, body: JSON }

  # ── Roots ──────────────────────────────────────────────────────────────────

  type Subscription {
    meterBalanceChanged(meterId: String!): MeterBalance!
    meterStatusChanged(meterId: String!): MeterStatus!
    paymentConfirmed(address: String!): Payment!
    usageUpdated(meterId: String!): UsageUpdate!
  }

  type Query {
    health: String!
    meter(id: String!): Meter
    metersByOwner(address: String!): [Meter!]!
    payments(meterId: String!): [Payment!]!
    usageHistory(meterId: String!, page: Int = 1, pageSize: Int = 20): UsageHistory!
    meterHealth(meterId: String!): MeterHealth
    meterHealthDashboard: MeterHealthDashboard!
    prediction(meterId: String!, balance: Float): Prediction

    solarForecast(capacityKw: Float!, peakSunHours: Float!, efficiency: Float = 0.2, panelAgeYears: Float = 0, ratePerKwh: Float = 0.12): SolarForecast!
    irradianceZones: [IrradianceZone!]!

    device(id: ID!): Device
    devices(owner: String, type: DeviceType, status: DeviceStatus, meterId: String, limit: Int = 50, offset: Int = 0): [Device!]!
    dueMaintenance(withinDays: Int = 7): [MaintenanceSchedule!]!
    expiringCertifications(withinDays: Int = 30): [Certification!]!

    weather(lat: Float!, lon: Float!): Weather!

    stakingStats: StakingStats!
    staker(address: String!): StakerInfo!
    votingPower(address: String!): String!

    """
    Read-only pass-through to any REST GET endpoint under /api (e.g.
    path: "/api/stats/summary"). Auth headers from the GraphQL request are
    forwarded, so the same access rules apply as for REST.
    """
    rest(path: String!): RestResponse!
  }

  type Mutation {
    registerDevice(input: RegisterDeviceInput!): Device!
    updateDevice(id: ID!, input: UpdateDeviceInput!): Device
    deleteDevice(id: ID!): Boolean!
    addCertification(deviceId: ID!, input: CertificationInput!): Certification!
    scheduleMaintenance(deviceId: ID!, input: MaintenanceInput!): MaintenanceSchedule!
    completeMaintenance(deviceId: ID!, scheduleId: ID!, performedAt: String): MaintenanceSchedule
    recordDevicePerformance(deviceId: ID!, input: PerformanceInput!): Boolean!
    recordHeartbeat(meterId: String!, responseTimeMs: Float, error: Boolean): MeterHealth

    """
    Pass-through to any mutating REST endpoint under /api (payments,
    webhooks, allowlist, delegates, ...). Auth headers are forwarded.
    """
    rest(method: HttpMethod!, path: String!, body: JSON): RestResponse!
  }
`;

export const schema = buildSchema(typeDefs);
