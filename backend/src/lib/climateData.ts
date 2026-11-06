/**
 * Climate data integration for risk assessment.
 * 
 * Fetches climate projection data from Open-Meteo Climate API and Open-Elevation API.
 * Implements Redis caching with 24-hour TTL and graceful degradation to SQLite-only mode.
 * Rate limiting ensures compliance with free-tier API limits (1 req/sec).
 */
import path from 'node:path';
import Database from 'better-sqlite3';
import Redis from 'ioredis';
import { registerDatabase } from './databaseLifecycle.js';
import { logger } from './logger.js';

const DB_PATH = process.env.CLIMATE_RISK_DB_PATH ?? path.resolve(process.cwd(), 'data', 'climate-risk.sqlite');

// ── Redis initialization with graceful degradation ──────────────────────────

export const redis = new Redis({
  host: process.env.REDIS_HOST ?? 'localhost',
  port: Number(process.env.REDIS_PORT ?? 6379),
  password: process.env.REDIS_PASSWORD,
  lazyConnect: true,
  connectTimeout: 5000,
  commandTimeout: 3000,
  retryStrategy: (times) => {
    if (times > 10) return null;
    return Math.min(Math.pow(2, times) * 100, 5000);
  },
});

export let redisAvailable = false;

redis.on('connect', () => {
  redisAvailable = true;
  logger.info('Redis connected for climate data caching');
});

redis.on('error', (err) => {
  redisAvailable = false;
  logger.warn({ err }, 'Redis unavailable - climate data cache disabled, using SQLite-only mode');
});

redis.on('close', () => {
  redisAvailable = false;
  logger.info('Redis connection closed');
});

// Attempt lazy connection
redis.connect().catch(() => {
  // Errors are handled by the 'error' event
});

// ── Database initialization ─────────────────────────────────────────────────

let _db: Database.Database | undefined;

function db(): Database.Database {
  if (!_db) {
    _db = new Database(DB_PATH);
    _db.pragma('journal_mode = WAL');
    _db.pragma('foreign_keys = OFF');
    
    _db.exec(`
      CREATE TABLE IF NOT EXISTS climate_projections (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        lat REAL NOT NULL,
        lon REAL NOT NULL,
        scenario TEXT NOT NULL,
        hazard_type TEXT NOT NULL,
        exposure_score REAL NOT NULL,
        projection_year INTEGER NOT NULL,
        metadata TEXT,
        fetched_at TEXT NOT NULL,
        UNIQUE(lat, lon, scenario, hazard_type, projection_year)
      );
      CREATE INDEX IF NOT EXISTS idx_climate_projections_location 
        ON climate_projections (lat, lon);
      CREATE INDEX IF NOT EXISTS idx_climate_projections_scenario 
        ON climate_projections (scenario, hazard_type);

      CREATE TABLE IF NOT EXISTS risk_assessments (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        meter_id TEXT NOT NULL,
        lat REAL NOT NULL,
        lon REAL NOT NULL,
        scenario TEXT NOT NULL,
        overall_risk_score REAL NOT NULL,
        flood_score REAL NOT NULL,
        heatwave_score REAL NOT NULL,
        storm_score REAL NOT NULL,
        insurance_tier TEXT NOT NULL,
        assessed_at TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_risk_assessments_meter 
        ON risk_assessments (meter_id, assessed_at DESC);
      CREATE INDEX IF NOT EXISTS idx_risk_assessments_tier 
        ON risk_assessments (insurance_tier);

      CREATE TABLE IF NOT EXISTS mitigation_plans (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        meter_id TEXT NOT NULL,
        hazard_type TEXT NOT NULL,
        recommendation TEXT NOT NULL,
        priority TEXT NOT NULL,
        estimated_cost_usd REAL,
        implementation_status TEXT DEFAULT 'pending',
        details TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        UNIQUE(meter_id, hazard_type, recommendation)
      );
      CREATE INDEX IF NOT EXISTS idx_mitigation_plans_meter 
        ON mitigation_plans (meter_id);
      CREATE INDEX IF NOT EXISTS idx_mitigation_plans_status 
        ON mitigation_plans (implementation_status);
    `);
    
    logger.info({ path: DB_PATH }, 'Climate risk database initialized');
  }
  return _db;
}

registerDatabase('climate-risk', () => {
  _db?.close();
  _db = undefined;
});

export { db };

// ── Types ───────────────────────────────────────────────────────────────────

export type ClimateScenario = 'RCP4.5' | 'RCP8.5' | 'SSP2' | 'SSP5';
export type HazardType = 'flood' | 'heatwave' | 'storm';

export type ClimateProjection = {
  lat: number;
  lon: number;
  scenario: ClimateScenario;
  hazardType: HazardType;
  exposureScore: number;
  projectionYear: number;
  metadata: {
    source: string;
    fetchedAt: string;
    confidence?: string;
  };
};

// ── Rate limiting ───────────────────────────────────────────────────────────

const apiCallTimestamps = new Map<string, number>();

async function rateLimitedFetch(api: string, url: string, signal?: AbortSignal): Promise<Response> {
  const lastCall = apiCallTimestamps.get(api) ?? 0;
  const timeSinceLastCall = Date.now() - lastCall;
  const minInterval = 1000; // 1 second between calls

  if (timeSinceLastCall < minInterval) {
    await new Promise(resolve => setTimeout(resolve, minInterval - timeSinceLastCall));
  }

  apiCallTimestamps.set(api, Date.now());
  return fetch(url, { signal: signal ?? AbortSignal.timeout(10000) });
}

// ── Cache helpers ───────────────────────────────────────────────────────────

async function getFromCache(key: string): Promise<string | null> {
  if (!redisAvailable) return null;
  try {
    return await redis.get(key);
  } catch (error) {
    logger.warn({ error, key }, 'Redis get failed, falling back to SQLite');
    return null;
  }
}

async function setInCache(key: string, value: string, ttlSeconds: number): Promise<void> {
  if (!redisAvailable) return;
  try {
    await redis.setex(key, ttlSeconds, value);
  } catch (error) {
    logger.warn({ error, key }, 'Redis set failed, continuing without cache');
  }
}

// ── SQLite fallback ─────────────────────────────────────────────────────────

type ProjectionRow = {
  lat: number;
  lon: number;
  scenario: string;
  hazard_type: string;
  exposure_score: number;
  projection_year: number;
  metadata: string;
  fetched_at: string;
};

function getFallbackProjection(
  lat: number,
  lon: number,
  scenario: ClimateScenario,
  hazardType: HazardType,
  year: number
): ClimateProjection | null {
  const maxAge = 7 * 24 * 60 * 60 * 1000; // 7 days
  const cutoff = new Date(Date.now() - maxAge).toISOString();
  
  const row = db()
    .prepare(
      `SELECT * FROM climate_projections 
       WHERE lat = ? AND lon = ? AND scenario = ? AND hazard_type = ? AND projection_year = ?
       AND fetched_at > ?
       ORDER BY fetched_at DESC LIMIT 1`
    )
    .get(lat, lon, scenario, hazardType, year, cutoff) as ProjectionRow | undefined;

  if (!row) return null;

  return {
    lat: row.lat,
    lon: row.lon,
    scenario: row.scenario as ClimateScenario,
    hazardType: row.hazard_type as HazardType,
    exposureScore: row.exposure_score,
    projectionYear: row.projection_year,
    metadata: JSON.parse(row.metadata),
  };
}

function storeProjection(projection: ClimateProjection): void {
  db()
    .prepare(
      `INSERT OR REPLACE INTO climate_projections 
       (lat, lon, scenario, hazard_type, exposure_score, projection_year, metadata, fetched_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
    )
    .run(
      projection.lat,
      projection.lon,
      projection.scenario,
      projection.hazardType,
      projection.exposureScore,
      projection.projectionYear,
      JSON.stringify(projection.metadata),
      projection.metadata.fetchedAt
    );
}

// ── Open-Elevation API ──────────────────────────────────────────────────────

export async function fetchElevation(lat: number, lon: number): Promise<number | null> {
  const cacheKey = `climate:elevation:${lat}:${lon}`;
  
  // Check Redis cache
  const cached = await getFromCache(cacheKey);
  if (cached !== null) {
    return parseFloat(cached);
  }

  try {
    const url = `https://api.open-elevation.com/api/v1/lookup?locations=${lat},${lon}`;
    const response = await rateLimitedFetch('open-elevation', url);
    
    if (!response.ok) {
      logger.warn({ lat, lon, status: response.status }, 'Open-Elevation API returned error');
      return null;
    }

    const data = await response.json();
    const elevation = data.results?.[0]?.elevation;
    
    if (typeof elevation === 'number') {
      await setInCache(cacheKey, elevation.toString(), 86400 * 30); // 30 days TTL
      return elevation;
    }
    
    return null;
  } catch (error) {
    logger.warn({ error, lat, lon }, 'Failed to fetch elevation data');
    return null;
  }
}

// ── Climate projection fetching ─────────────────────────────────────────────

export async function fetchClimateProjection(
  location: { lat: number; lon: number },
  scenario: ClimateScenario,
  hazardType: HazardType,
  year: number
): Promise<ClimateProjection> {
  const cacheKey = `climate:projection:${location.lat}:${location.lon}:${scenario}:${hazardType}:${year}`;
  
  // Check Redis cache (24h TTL)
  const cached = await getFromCache(cacheKey);
  if (cached !== null) {
    return JSON.parse(cached) as ClimateProjection;
  }

  // Check SQLite fallback (stale OK if < 7 days)
  const fallback = getFallbackProjection(location.lat, location.lon, scenario, hazardType, year);
  if (fallback) {
    // Update Redis cache with fallback data
    await setInCache(cacheKey, JSON.stringify(fallback), 86400);
    return fallback;
  }

  // Fetch fresh data from Open-Meteo Climate API
  try {
    const projection = await fetchFromClimateApi(location, scenario, hazardType, year);
    
    // Store in SQLite
    storeProjection(projection);
    
    // Cache in Redis
    await setInCache(cacheKey, JSON.stringify(projection), 86400);
    
    return projection;
  } catch (error) {
    logger.error({ error, location, scenario, hazardType, year }, 'Failed to fetch climate projection');
    throw error;
  }
}

async function fetchFromClimateApi(
  location: { lat: number; lon: number },
  scenario: ClimateScenario,
  hazardType: HazardType,
  year: number
): Promise<ClimateProjection> {
  // Map our scenario names to Open-Meteo model names
  const modelMap: Record<ClimateScenario, string> = {
    'RCP4.5': 'CMIP6',
    'RCP8.5': 'CMIP6',
    'SSP2': 'CMIP6',
    'SSP5': 'CMIP6',
  };

  const startDate = `${year}-01-01`;
  const endDate = `${year}-12-31`;
  
  const url = `https://climate-api.open-meteo.com/v1/climate?` +
    `latitude=${location.lat}&longitude=${location.lon}` +
    `&start_date=${startDate}&end_date=${endDate}` +
    `&models=${modelMap[scenario]}` +
    `&daily=temperature_2m_mean,temperature_2m_max,precipitation_sum,wind_speed_10m_max`;

  const response = await rateLimitedFetch('open-meteo-climate', url);

  if (!response.ok) {
    throw new Error(`Climate API returned ${response.status}: ${response.statusText}`);
  }

  const data = await response.json();
  
  // Calculate exposure score based on hazard type
  const exposureScore = calculateExposureScore(data, hazardType, location);
  
  const projection: ClimateProjection = {
    lat: location.lat,
    lon: location.lon,
    scenario,
    hazardType,
    exposureScore,
    projectionYear: year,
    metadata: {
      source: 'Open-Meteo Climate API',
      fetchedAt: new Date().toISOString(),
      confidence: 'CMIP6',
    },
  };

  return projection;
}

async function calculateExposureScore(
  data: any,
  hazardType: HazardType,
  location: { lat: number; lon: number }
): Promise<number> {
  const daily = data.daily || {};
  
  if (hazardType === 'heatwave') {
    // Temperature anomaly calculation
    const temps = daily.temperature_2m_mean || [];
    if (temps.length === 0) return 0;
    
    const avgTemp = temps.reduce((sum: number, t: number) => sum + t, 0) / temps.length;
    // Baseline assumption: 1991-2020 average ~15°C
    const baseline = 15;
    const tempAnomaly = avgTemp - baseline;
    
    // Formula: min(100, (tempAnomaly / 5) * 100)
    return Math.min(100, Math.max(0, (tempAnomaly / 5) * 100));
  }
  
  if (hazardType === 'flood') {
    // Precipitation anomaly + elevation penalty
    const precip = daily.precipitation_sum || [];
    if (precip.length === 0) return 0;
    
    const avgPrecip = precip.reduce((sum: number, p: number) => sum + p, 0) / precip.length;
    const precipAnomaly = avgPrecip; // Daily average
    
    // Fetch elevation data
    const elevation = await fetchElevation(location.lat, location.lon);
    const elevationPenalty = elevation !== null ? Math.max(0, (10 - elevation) / 10) : 0;
    
    // Formula: min(100, (precipAnomaly / 10) * 50 + elevationPenalty * 50)
    return Math.min(100, Math.max(0, (precipAnomaly / 10) * 50 + elevationPenalty * 50));
  }
  
  if (hazardType === 'storm') {
    // Wind speed preferred, precipitation fallback
    const windSpeeds = daily.wind_speed_10m_max || [];
    const precip = daily.precipitation_sum || [];
    
    if (windSpeeds.length > 0) {
      const avgWind = windSpeeds.reduce((sum: number, w: number) => sum + w, 0) / windSpeeds.length;
      // Convert m/s to km/h: 1 m/s = 3.6 km/h
      const windSpeedKmh = avgWind * 3.6;
      
      if (precip.length > 0) {
        const avgPrecip = precip.reduce((sum: number, p: number) => sum + p, 0) / precip.length;
        const precipIntensity = avgPrecip;
        // Formula: min(100, (windSpeedKmh / 100) * 60 + (precipIntensity / 50) * 40)
        return Math.min(100, Math.max(0, (windSpeedKmh / 100) * 60 + (precipIntensity / 50) * 40));
      }
      
      // Wind only
      return Math.min(100, Math.max(0, (windSpeedKmh / 100) * 100));
    }
    
    // Precipitation-only fallback
    if (precip.length > 0) {
      const avgPrecip = precip.reduce((sum: number, p: number) => sum + p, 0) / precip.length;
      logger.warn({ location, hazardType }, 'Using precipitation-only storm score (wind data unavailable)');
      // Formula: min(100, (dailyPrecipMm / 100) * 100)
      return Math.min(100, Math.max(0, (avgPrecip / 100) * 100));
    }
    
    return 0;
  }
  
  return 0;
}
