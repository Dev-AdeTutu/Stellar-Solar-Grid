/**
 * Energy Price Heatmap Service
 * Manages grid zones and real-time price data for visualization
 */

import path from 'node:path';
import { mkdirSync } from 'node:fs';
import Database from 'better-sqlite3';
import { registerDatabase } from './databaseLifecycle.js';
import { logger } from './logger.js';
import { EventEmitter } from 'events';

const DB_PATH = process.env.PRICE_HEATMAP_DB_PATH ?? path.resolve(process.cwd(), 'data', 'price_heatmap.sqlite');

export interface GridZone {
  id: string;
  name: string;
  region: string;
  latitude: number;
  longitude: number;
  radius: number; // in meters
  population: number;
  basePrice: number;
  geometry?: any; // GeoJSON geometry
  metadata?: Record<string, any>;
  createdAt: Date;
}

export interface PriceData {
  zoneId: string;
  price: number;
  timestamp: Date;
  demand: number;
  supply: number;
  congestion: number;
}

export interface PriceSnapshot {
  timestamp: Date;
  zones: Map<string, number>; // zoneId -> price
}

export interface HeatmapQuery {
  startTime?: Date;
  endTime?: Date;
  zoneIds?: string[];
  regions?: string[];
}

let _db: Database.Database | undefined;

function db(): Database.Database {
  if (!_db) {
    mkdirSync(path.dirname(DB_PATH), { recursive: true });
    _db = new Database(DB_PATH);
    _db.pragma('journal_mode = WAL');
    registerDatabase(_db, 'price_heatmap');
  }
  return _db;
}

let db: Database.Database;
const priceUpdateEmitter = new EventEmitter();
const realtimePriceCache = new Map<string, PriceData>();

/**
 * Initialize price heatmap system
 */
export function initPriceHeatmap(): void {
  const database = db();
  
  // Create tables
  database.exec(`
    CREATE TABLE IF NOT EXISTS grid_zones (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      region TEXT NOT NULL,
      latitude REAL NOT NULL,
      longitude REAL NOT NULL,
      radius REAL NOT NULL,
      population INTEGER DEFAULT 0,
      base_price REAL DEFAULT 0.15,
      geometry TEXT,
      metadata TEXT,
      created_at INTEGER NOT NULL
    );

    CREATE TABLE IF NOT EXISTS zone_prices (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      zone_id TEXT NOT NULL,
      price REAL NOT NULL,
      timestamp INTEGER NOT NULL,
      demand REAL DEFAULT 0,
      supply REAL DEFAULT 0,
      congestion REAL DEFAULT 0,
      FOREIGN KEY (zone_id) REFERENCES grid_zones(id)
    );

    CREATE TABLE IF NOT EXISTS price_snapshots (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      timestamp INTEGER NOT NULL,
      snapshot_data TEXT NOT NULL,
      zones_count INTEGER NOT NULL
    );

    CREATE INDEX IF NOT EXISTS idx_zone_prices_zone 
      ON zone_prices(zone_id);
    CREATE INDEX IF NOT EXISTS idx_zone_prices_timestamp 
      ON zone_prices(timestamp);
    CREATE INDEX IF NOT EXISTS idx_zone_prices_zone_time 
      ON zone_prices(zone_id, timestamp);
    CREATE INDEX IF NOT EXISTS idx_snapshots_timestamp 
      ON price_snapshots(timestamp);
  `);

  // Initialize sample grid zones if empty
  initializeSampleZones();

  logger.info('Price heatmap system initialized');
}

/**
 * Initialize sample grid zones for testing
 */
function initializeSampleZones(): void {
  const count = db().prepare('SELECT COUNT(*) as count FROM grid_zones').get() as { count: number };
  
  if (count.count === 0) {
    logger.info('Initializing sample grid zones');
    
    // Generate grid zones across a geographic area
    // Example: SF Bay Area grid
    const baseLatitude = 37.7749;
    const baseLongitude = -122.4194;
    const gridSize = 10; // 10x10 grid
    const spacing = 0.1; // degrees
    
    const zones: GridZone[] = [];
    
    for (let i = 0; i < gridSize; i++) {
      for (let j = 0; j < gridSize; j++) {
        const zoneId = `zone_${i}_${j}`;
        const lat = baseLatitude + (i - gridSize / 2) * spacing;
        const lon = baseLongitude + (j - gridSize / 2) * spacing;
        
        zones.push({
          id: zoneId,
          name: `Zone ${i}-${j}`,
          region: `Region ${Math.floor(i / 3)}-${Math.floor(j / 3)}`,
          latitude: lat,
          longitude: lon,
          radius: 5000, // 5km
          population: Math.floor(Math.random() * 50000) + 10000,
          basePrice: 0.12 + Math.random() * 0.06, // $0.12 - $0.18 per kWh
          createdAt: new Date()
        });
      }
    }
    
    // Insert zones
    const insert = db().prepare(`
      INSERT INTO grid_zones 
      (id, name, region, latitude, longitude, radius, population, base_price, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);
    
    for (const zone of zones) {
      insert.run(
        zone.id,
        zone.name,
        zone.region,
        zone.latitude,
        zone.longitude,
        zone.radius,
        zone.population,
        zone.basePrice,
        zone.createdAt.getTime()
      );
    }
    
    logger.info(`Initialized ${zones.length} sample grid zones`);
    
    // Generate initial price data
    generatePriceData();
  }
}

/**
 * Generate simulated price data for all zones
 */
function generatePriceData(): void {
  const zones = getAllZones();
  const now = Date.now();
  
  const insert = db().prepare(`
    INSERT INTO zone_prices (zone_id, price, timestamp, demand, supply, congestion)
    VALUES (?, ?, ?, ?, ?, ?)
  `);
  
  for (const zone of zones) {
    // Simulate price variation based on time and location
    const hourOfDay = new Date().getHours();
    const isPeakHour = hourOfDay >= 16 && hourOfDay <= 20;
    const peakMultiplier = isPeakHour ? 1.3 : 1.0;
    
    // Add some randomness and congestion
    const congestion = Math.random() * 0.3;
    const demand = 500 + Math.random() * 1000;
    const supply = 400 + Math.random() * 1200;
    
    const price = zone.basePrice * peakMultiplier * (1 + congestion);
    
    insert.run(zone.id, price, now, demand, supply, congestion);
    
    // Update cache
    realtimePriceCache.set(zone.id, {
      zoneId: zone.id,
      price,
      timestamp: new Date(now),
      demand,
      supply,
      congestion
    });
  }
  
  // Create snapshot
  createPriceSnapshot();
}

/**
 * Get all grid zones
 */
export function getAllZones(): GridZone[] {
  const rows = db().prepare('SELECT * FROM grid_zones').all() as any[];
  
  return rows.map(row => ({
    id: row.id,
    name: row.name,
    region: row.region,
    latitude: row.latitude,
    longitude: row.longitude,
    radius: row.radius,
    population: row.population,
    basePrice: row.base_price,
    geometry: row.geometry ? JSON.parse(row.geometry) : undefined,
    metadata: row.metadata ? JSON.parse(row.metadata) : undefined,
    createdAt: new Date(row.created_at)
  }));
}

/**
 * Get zone by ID
 */
export function getZoneById(zoneId: string): GridZone | null {
  const row = db().prepare('SELECT * FROM grid_zones WHERE id = ?').get(zoneId) as any;
  
  if (!row) return null;
  
  return {
    id: row.id,
    name: row.name,
    region: row.region,
    latitude: row.latitude,
    longitude: row.longitude,
    radius: row.radius,
    population: row.population,
    basePrice: row.base_price,
    geometry: row.geometry ? JSON.parse(row.geometry) : undefined,
    metadata: row.metadata ? JSON.parse(row.metadata) : undefined,
    createdAt: new Date(row.created_at)
  };
}

/**
 * Get current prices for all zones
 */
export function getCurrentPrices(): Map<string, PriceData> {
  if (realtimePriceCache.size === 0) {
    // Load latest prices from database
    const rows = db().prepare(`
      SELECT zp.*
      FROM zone_prices zp
      INNER JOIN (
        SELECT zone_id, MAX(timestamp) as max_ts
        FROM zone_prices
        GROUP BY zone_id
      ) latest ON zp.zone_id = latest.zone_id AND zp.timestamp = latest.max_ts
    `).all() as any[];
    
    for (const row of rows) {
      realtimePriceCache.set(row.zone_id, {
        zoneId: row.zone_id,
        price: row.price,
        timestamp: new Date(row.timestamp),
        demand: row.demand,
        supply: row.supply,
        congestion: row.congestion
      });
    }
  }
  
  return new Map(realtimePriceCache);
}

/**
 * Update price for a zone
 */
export function updateZonePrice(
  zoneId: string,
  price: number,
  demand: number = 0,
  supply: number = 0,
  congestion: number = 0
): void {
  const now = Date.now();
  
  // Insert into database
  db().prepare(`
    INSERT INTO zone_prices (zone_id, price, timestamp, demand, supply, congestion)
    VALUES (?, ?, ?, ?, ?, ?)
  `).run(zoneId, price, now, demand, supply, congestion);
  
  // Update cache
  const priceData: PriceData = {
    zoneId,
    price,
    timestamp: new Date(now),
    demand,
    supply,
    congestion
  };
  
  realtimePriceCache.set(zoneId, priceData);
  
  // Emit update event
  priceUpdateEmitter.emit('priceUpdate', priceData);
}

/**
 * Create a price snapshot
 */
function createPriceSnapshot(): void {
  const prices = getCurrentPrices();
  const snapshotData: Record<string, number> = {};
  
  prices.forEach((data, zoneId) => {
    snapshotData[zoneId] = data.price;
  });
  
  db().prepare(`
    INSERT INTO price_snapshots (timestamp, snapshot_data, zones_count)
    VALUES (?, ?, ?)
  `).run(
    Date.now(),
    JSON.stringify(snapshotData),
    prices.size
  );
}

/**
 * Get historical price data
 */
export function getHistoricalPrices(query: HeatmapQuery): PriceSnapshot[] {
  let sql = `
    SELECT timestamp, snapshot_data
    FROM price_snapshots
    WHERE 1=1
  `;
  const params: any[] = [];
  
  if (query.startTime) {
    sql += ' AND timestamp >= ?';
    params.push(query.startTime.getTime());
  }
  
  if (query.endTime) {
    sql += ' AND timestamp <= ?';
    params.push(query.endTime.getTime());
  }
  
  sql += ' ORDER BY timestamp ASC';
  
  const rows = db().prepare(sql).all(...params) as any[];
  
  return rows.map(row => {
    const data = JSON.parse(row.snapshot_data);
    const zones = new Map<string, number>();
    
    Object.entries(data).forEach(([zoneId, price]) => {
      if (!query.zoneIds || query.zoneIds.includes(zoneId)) {
        zones.set(zoneId, price as number);
      }
    });
    
    return {
      timestamp: new Date(row.timestamp),
      zones
    };
  });
}

/**
 * Get price statistics for a zone
 */
export function getZonePriceStats(
  zoneId: string,
  startTime?: Date,
  endTime?: Date
): {
  minPrice: number;
  maxPrice: number;
  avgPrice: number;
  currentPrice: number;
} {
  let sql = `
    SELECT 
      MIN(price) as min_price,
      MAX(price) as max_price,
      AVG(price) as avg_price
    FROM zone_prices
    WHERE zone_id = ?
  `;
  const params: any[] = [zoneId];
  
  if (startTime) {
    sql += ' AND timestamp >= ?';
    params.push(startTime.getTime());
  }
  
  if (endTime) {
    sql += ' AND timestamp <= ?';
    params.push(endTime.getTime());
  }
  
  const stats = db().prepare(sql).get(...params) as any;
  const currentPrice = realtimePriceCache.get(zoneId)?.price || 0;
  
  return {
    minPrice: stats?.min_price || 0,
    maxPrice: stats?.max_price || 0,
    avgPrice: stats?.avg_price || 0,
    currentPrice
  };
}

/**
 * Get zones by region
 */
export function getZonesByRegion(region: string): GridZone[] {
  const rows = db().prepare('SELECT * FROM grid_zones WHERE region = ?').all(region) as any[];
  
  return rows.map(row => ({
    id: row.id,
    name: row.name,
    region: row.region,
    latitude: row.latitude,
    longitude: row.longitude,
    radius: row.radius,
    population: row.population,
    basePrice: row.base_price,
    geometry: row.geometry ? JSON.parse(row.geometry) : undefined,
    metadata: row.metadata ? JSON.parse(row.metadata) : undefined,
    createdAt: new Date(row.created_at)
  }));
}

/**
 * Get zones within bounding box
 */
export function getZonesInBoundingBox(
  minLat: number,
  maxLat: number,
  minLon: number,
  maxLon: number
): GridZone[] {
  const rows = db().prepare(`
    SELECT * FROM grid_zones
    WHERE latitude >= ? AND latitude <= ?
    AND longitude >= ? AND longitude <= ?
  `).all(minLat, maxLat, minLon, maxLon) as any[];
  
  return rows.map(row => ({
    id: row.id,
    name: row.name,
    region: row.region,
    latitude: row.latitude,
    longitude: row.longitude,
    radius: row.radius,
    population: row.population,
    basePrice: row.base_price,
    geometry: row.geometry ? JSON.parse(row.geometry) : undefined,
    metadata: row.metadata ? JSON.parse(row.metadata) : undefined,
    createdAt: new Date(row.created_at)
  }));
}

/**
 * Subscribe to price updates
 */
export function subscribeToPriceUpdates(callback: (data: PriceData) => void): () => void {
  priceUpdateEmitter.on('priceUpdate', callback);
  
  // Return unsubscribe function
  return () => {
    priceUpdateEmitter.off('priceUpdate', callback);
  };
}

/**
 * Start real-time price simulation
 */
let simulationInterval: NodeJS.Timeout | null = null;

export function startPriceSimulation(intervalMs: number = 5000): void {
  if (simulationInterval) {
    logger.warn('Price simulation already running');
    return;
  }
  
  simulationInterval = setInterval(() => {
    try {
      const zones = getAllZones();
      const hourOfDay = new Date().getHours();
      const isPeakHour = hourOfDay >= 16 && hourOfDay <= 20;
      
      for (const zone of zones) {
        // Simulate realistic price changes
        const currentPrice = realtimePriceCache.get(zone.id)?.price || zone.basePrice;
        
        // Add randomness ±5%
        const change = (Math.random() - 0.5) * 0.1;
        const peakMultiplier = isPeakHour ? 1.2 : 1.0;
        
        const newPrice = Math.max(
          zone.basePrice * 0.8,
          Math.min(
            zone.basePrice * 2.0,
            currentPrice * (1 + change) * peakMultiplier
          )
        );
        
        const demand = 500 + Math.random() * 1000;
        const supply = 400 + Math.random() * 1200;
        const congestion = Math.max(0, (demand - supply) / demand);
        
        updateZonePrice(zone.id, newPrice, demand, supply, congestion);
      }
      
      // Create periodic snapshots (every 10 updates)
      const updateCount = Math.floor(Date.now() / intervalMs) % 10;
      if (updateCount === 0) {
        createPriceSnapshot();
      }
    } catch (error) {
      logger.error('Error in price simulation', { error });
    }
  }, intervalMs);
  
  logger.info('Price simulation started', { intervalMs });
}

/**
 * Stop price simulation
 */
export function stopPriceSimulation(): void {
  if (simulationInterval) {
    clearInterval(simulationInterval);
    simulationInterval = null;
    logger.info('Price simulation stopped');
  }
}

/**
 * Get heatmap data optimized for rendering
 */
export function getHeatmapData(): {
  zones: Array<{
    id: string;
    lat: number;
    lon: number;
    price: number;
    name: string;
    region: string;
  }>;
  priceRange: { min: number; max: number };
  timestamp: Date;
} {
  const zones = getAllZones();
  const prices = getCurrentPrices();
  
  let minPrice = Infinity;
  let maxPrice = -Infinity;
  
  const heatmapZones = zones.map(zone => {
    const priceData = prices.get(zone.id);
    const price = priceData?.price || zone.basePrice;
    
    if (price < minPrice) minPrice = price;
    if (price > maxPrice) maxPrice = price;
    
    return {
      id: zone.id,
      lat: zone.latitude,
      lon: zone.longitude,
      price,
      name: zone.name,
      region: zone.region
    };
  });
  
  return {
    zones: heatmapZones,
    priceRange: { min: minPrice, max: maxPrice },
    timestamp: new Date()
  };
}
