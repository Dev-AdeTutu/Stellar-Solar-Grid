/**
 * Energy Arbitrage Opportunities Detector (#1009)
 *
 * Monitors real-time and 24-hour grid prices alongside solar generation,
 * calculates optimal battery charge/discharge schedules, estimates profit
 * potential, and emits alerts when profitable arbitrage windows are detected.
 */

export interface HourlyMarketSlot {
  hour: number; // 0..23 UTC
  gridPricePerKwh: number;
  solarGenerationKwh: number;
  demandKwh: number;
}

export interface ArbitrageScheduleSlot {
  hour: number;
  action: "charge" | "discharge" | "hold";
  source: "solar" | "grid" | "battery" | "none";
  energyKwh: number;
  gridPricePerKwh: number;
  solarGenerationKwh: number;
  batterySocKwh: number;
  cashflowUsd: number;
}

export interface ArbitrageWindowOpportunity {
  id: string;
  meterId: string;
  chargeWindowStartHour: number;
  chargeWindowEndHour: number;
  dischargeWindowStartHour: number;
  dischargeWindowEndHour: number;
  avgChargePricePerKwh: number;
  avgDischargePricePerKwh: number;
  spreadPerKwh: number;
  spreadPercent: number;
  recommendedKwh: number;
  estimatedProfitUsd: number;
  solarAssistKwh: number;
  confidence: number;
  recommendation: string;
}

export interface ArbitrageAlert {
  id: string;
  meterId: string;
  severity: "info" | "high_profit";
  message: string;
  estimatedProfitUsd: number;
  triggeredAt: string;
}

export interface MeterArbitrageReport {
  meterId: string;
  generatedAt: string;
  batteryCapacityKwh: number;
  roundTripEfficiency: number;
  currentGridPricePerKwh: number;
  currentSolarGenerationKw: number;
  estimatedDailyProfitUsd: number;
  estimatedMonthlyProfitUsd: number;
  opportunities: ArbitrageWindowOpportunity[];
  optimalSchedule: ArbitrageScheduleSlot[];
  alerts: ArbitrageAlert[];
}

export interface ArbitrageDetectorOptions {
  batteryCapacityKwh?: number;
  initialSocKwh?: number;
  maxChargeRateKw?: number;
  roundTripEfficiency?: number;
  minSpreadPercent?: number;
  hourlySlots?: HourlyMarketSlot[];
}

const alertsByMeter = new Map<string, ArbitrageAlert[]>();

/**
 * Generate a realistic 24-hour grid price & solar generation profile for a meter
 * if custom telemetry slots are not supplied.
 */
export function buildDefaultMarketProfile(meterId: string): HourlyMarketSlot[] {
  // Deterministic seed offset from meterId
  let hash = 0;
  for (let i = 0; i < meterId.length; i++) {
    hash = (hash * 31 + meterId.charCodeAt(i)) % 1000;
  }
  const offset = (hash % 20) / 1000; // 0.000 .. 0.019

  const slots: HourlyMarketSlot[] = [];
  for (let hour = 0; hour < 24; hour++) {
    // Off-peak (00-06): ~$0.08/kWh; Midday solar dip (10-15): ~$0.09/kWh; Evening peak (17-21): ~$0.28-$0.34/kWh
    let basePrice = 0.14;
    if (hour >= 0 && hour <= 5) basePrice = 0.08;
    else if (hour >= 10 && hour <= 14) basePrice = 0.09;
    else if (hour >= 17 && hour <= 21) basePrice = 0.31;

    // Solar bell curve between 06:00 and 18:00
    let solarKwh = 0;
    if (hour >= 6 && hour <= 18) {
      const radians = ((hour - 6) / 12) * Math.PI;
      solarKwh = Number((Math.sin(radians) * 4.2).toFixed(2));
    }

    const demandKwh = hour >= 17 && hour <= 22 ? 2.1 : hour >= 7 && hour <= 9 ? 1.5 : 0.8;

    slots.push({
      hour,
      gridPricePerKwh: Number((basePrice + offset).toFixed(4)),
      solarGenerationKwh: solarKwh,
      demandKwh,
    });
  }
  return slots;
}

/**
 * Calculate the optimal 24h charge/discharge schedule and identify arbitrage opportunities.
 */
export function detectMeterArbitrage(
  meterId: string,
  options: ArbitrageDetectorOptions = {},
): MeterArbitrageReport {
  const batteryCapacityKwh = options.batteryCapacityKwh ?? 13.5;
  const maxChargeRateKw = options.maxChargeRateKw ?? 5.0;
  const roundTripEfficiency = options.roundTripEfficiency ?? 0.9;
  const minSpreadPercent = options.minSpreadPercent ?? 20;
  const slots = options.hourlySlots ?? buildDefaultMarketProfile(meterId);

  const sortedByPrice = [...slots].sort((a, b) => a.gridPricePerKwh - b.gridPricePerKwh);
  const cheapestHours = new Set(sortedByPrice.slice(0, 6).map((s) => s.hour));
  const expensiveHours = new Set(sortedByPrice.slice(-5).map((s) => s.hour));

  let soc = options.initialSocKwh ?? batteryCapacityKwh * 0.2;
  const optimalSchedule: ArbitrageScheduleSlot[] = [];

  for (const slot of slots) {
    const excessSolar = Math.max(0, slot.solarGenerationKwh - slot.demandKwh);
    let action: "charge" | "discharge" | "hold" = "hold";
    let source: "solar" | "grid" | "battery" | "none" = "none";
    let energyKwh = 0;
    let cashflowUsd = 0;

    if (excessSolar > 0 && soc < batteryCapacityKwh) {
      action = "charge";
      source = "solar";
      energyKwh = Math.min(maxChargeRateKw, excessSolar, batteryCapacityKwh - soc);
      soc = Number((soc + energyKwh * Math.sqrt(roundTripEfficiency)).toFixed(3));
      cashflowUsd = 0; // Free solar charging
    } else if (cheapestHours.has(slot.hour) && soc < batteryCapacityKwh) {
      action = "charge";
      source = "grid";
      energyKwh = Math.min(maxChargeRateKw, batteryCapacityKwh - soc);
      soc = Number((soc + energyKwh * Math.sqrt(roundTripEfficiency)).toFixed(3));
      cashflowUsd = Number((-energyKwh * slot.gridPricePerKwh).toFixed(4));
    } else if (expensiveHours.has(slot.hour) && soc > batteryCapacityKwh * 0.1) {
      action = "discharge";
      source = "battery";
      const available = soc - batteryCapacityKwh * 0.1;
      energyKwh = Math.min(maxChargeRateKw, available);
      soc = Number((soc - energyKwh).toFixed(3));
      const deliveredKwh = energyKwh * Math.sqrt(roundTripEfficiency);
      cashflowUsd = Number((deliveredKwh * slot.gridPricePerKwh).toFixed(4));
    }

    optimalSchedule.push({
      hour: slot.hour,
      action,
      source,
      energyKwh: Number(energyKwh.toFixed(3)),
      gridPricePerKwh: slot.gridPricePerKwh,
      solarGenerationKwh: slot.solarGenerationKwh,
      batterySocKwh: soc,
      cashflowUsd,
    });
  }

  // Identify distinct arbitrage windows (Off-Peak Grid -> Evening Peak, and Midday Solar -> Evening Peak)
  const nightSlots = slots.filter((s) => s.hour >= 0 && s.hour <= 5);
  const solarSlots = slots.filter((s) => s.hour >= 10 && s.hour <= 15);
  const peakSlots = slots.filter((s) => s.hour >= 17 && s.hour <= 21);

  const avgPrice = (arr: HourlyMarketSlot[]) =>
    arr.length ? arr.reduce((sum, s) => sum + s.gridPricePerKwh, 0) / arr.length : 0;

  const avgNightPrice = avgPrice(nightSlots);
  const avgSolarGridPrice = avgPrice(solarSlots);
  const avgPeakPrice = avgPrice(peakSlots);
  const totalSolarAssist = solarSlots.reduce((sum, s) => sum + Math.max(0, s.solarGenerationKwh - s.demandKwh), 0);

  const opportunities: ArbitrageWindowOpportunity[] = [];

  if (avgNightPrice > 0 && avgPeakPrice > avgNightPrice) {
    const effectiveChargeCost = avgNightPrice / roundTripEfficiency;
    const spreadPerKwh = Number((avgPeakPrice - effectiveChargeCost).toFixed(4));
    const spreadPercent = Number((((avgPeakPrice - avgNightPrice) / avgNightPrice) * 100).toFixed(1));
    if (spreadPercent >= minSpreadPercent && spreadPerKwh > 0) {
      const usableKwh = Number((batteryCapacityKwh * 0.8).toFixed(2));
      const estimatedProfitUsd = Number((usableKwh * spreadPerKwh).toFixed(2));
      opportunities.push({
        id: `${meterId}-arb-night-peak`,
        meterId,
        chargeWindowStartHour: 1,
        chargeWindowEndHour: 5,
        dischargeWindowStartHour: 17,
        dischargeWindowEndHour: 21,
        avgChargePricePerKwh: Number(avgNightPrice.toFixed(4)),
        avgDischargePricePerKwh: Number(avgPeakPrice.toFixed(4)),
        spreadPerKwh,
        spreadPercent,
        recommendedKwh: usableKwh,
        estimatedProfitUsd,
        solarAssistKwh: 0,
        confidence: 0.92,
        recommendation: `Charge battery from grid between 01:00–05:00 ($${avgNightPrice.toFixed(
          2,
        )}/kWh) and discharge during 17:00–21:00 peak ($${avgPeakPrice.toFixed(2)}/kWh).`,
      });
    }
  }

  if (totalSolarAssist > 0 && avgPeakPrice > 0) {
    const usableSolarKwh = Number(Math.min(batteryCapacityKwh * 0.85, totalSolarAssist).toFixed(2));
    const estimatedProfitUsd = Number(
      (usableSolarKwh * roundTripEfficiency * avgPeakPrice).toFixed(2),
    );
    const spreadPercent =
      avgSolarGridPrice > 0
        ? Number((((avgPeakPrice - avgSolarGridPrice) / avgSolarGridPrice) * 100).toFixed(1))
        : 100;
    opportunities.push({
      id: `${meterId}-arb-solar-peak`,
      meterId,
      chargeWindowStartHour: 10,
      chargeWindowEndHour: 15,
      dischargeWindowStartHour: 17,
      dischargeWindowEndHour: 21,
      avgChargePricePerKwh: 0,
      avgDischargePricePerKwh: Number(avgPeakPrice.toFixed(4)),
      spreadPerKwh: Number((avgPeakPrice * roundTripEfficiency).toFixed(4)),
      spreadPercent,
      recommendedKwh: usableSolarKwh,
      estimatedProfitUsd,
      solarAssistKwh: usableSolarKwh,
      confidence: 0.89,
      recommendation: `Store ${usableSolarKwh} kWh of midday excess solar (10:00–15:00) and discharge during evening peak (17:00–21:00) to save/earn $${estimatedProfitUsd}.`,
    });
  }

  const estimatedDailyProfitUsd = Number(
    opportunities.reduce((sum, o) => sum + o.estimatedProfitUsd, 0).toFixed(2),
  );
  const estimatedMonthlyProfitUsd = Number((estimatedDailyProfitUsd * 30).toFixed(2));

  const alerts: ArbitrageAlert[] = [];
  for (const opp of opportunities) {
    if (opp.estimatedProfitUsd >= 0.5) {
      alerts.push({
        id: `alert-${opp.id}`,
        meterId,
        severity: opp.estimatedProfitUsd >= 2.0 ? "high_profit" : "info",
        message: `Arbitrage opportunity detected: ${opp.recommendation}`,
        estimatedProfitUsd: opp.estimatedProfitUsd,
        triggeredAt: new Date().toISOString(),
      });
    }
  }
  alertsByMeter.set(meterId, alerts);

  const nowHour = new Date().getUTCHours();
  const currentSlot = slots.find((s) => s.hour === nowHour) ?? slots[0];

  return {
    meterId,
    generatedAt: new Date().toISOString(),
    batteryCapacityKwh,
    roundTripEfficiency,
    currentGridPricePerKwh: currentSlot.gridPricePerKwh,
    currentSolarGenerationKw: currentSlot.solarGenerationKwh,
    estimatedDailyProfitUsd,
    estimatedMonthlyProfitUsd,
    opportunities,
    optimalSchedule,
    alerts,
  };
}

export function getMeterArbitrageAlerts(meterId: string): ArbitrageAlert[] {
  return alertsByMeter.get(meterId) ?? [];
}
