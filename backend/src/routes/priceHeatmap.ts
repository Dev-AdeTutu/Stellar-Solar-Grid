/**
 * Price Heatmap API Routes
 */

import express, { Request, Response, NextFunction } from 'express';
import {
  getAllZones,
  getZoneById,
  getCurrentPrices,
  getHistoricalPrices,
  getZonePriceStats,
  getZonesByRegion,
  getZonesInBoundingBox,
  getHeatmapData
} from '../lib/priceHeatmap.js';
import { logger } from '../lib/logger.js';

const router = express.Router();

/**
 * GET /api/heatmap/zones
 * Get all grid zones
 */
router.get('/zones', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { region, minLat, maxLat, minLon, maxLon } = req.query;
    
    let zones;
    
    if (region) {
      zones = getZonesByRegion(region as string);
    } else if (minLat && maxLat && minLon && maxLon) {
      zones = getZonesInBoundingBox(
        parseFloat(minLat as string),
        parseFloat(maxLat as string),
        parseFloat(minLon as string),
        parseFloat(maxLon as string)
      );
    } else {
      zones = getAllZones();
    }
    
    res.json({
      success: true,
      zones: zones.map(z => ({
        id: z.id,
        name: z.name,
        region: z.region,
        latitude: z.latitude,
        longitude: z.longitude,
        radius: z.radius,
        population: z.population,
        basePrice: z.basePrice
      })),
      count: zones.length
    });
  } catch (error: any) {
    logger.error('Error fetching zones', { error: error.message });
    next(error);
  }
});

/**
 * GET /api/heatmap/zones/:zoneId
 * Get specific zone details
 */
router.get('/zones/:zoneId', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { zoneId } = req.params;
    const zone = getZoneById(zoneId);
    
    if (!zone) {
      return res.status(404).json({
        success: false,
        error: 'Zone not found'
      });
    }
    
    // Get current price
    const prices = getCurrentPrices();
    const currentPrice = prices.get(zoneId);
    
    // Get stats
    const stats = getZonePriceStats(zoneId);
    
    res.json({
      success: true,
      zone: {
        ...zone,
        currentPrice: currentPrice?.price,
        demand: currentPrice?.demand,
        supply: currentPrice?.supply,
        congestion: currentPrice?.congestion,
        stats
      }
    });
  } catch (error: any) {
    logger.error('Error fetching zone', { error: error.message });
    next(error);
  }
});

/**
 * GET /api/heatmap/current
 * Get current prices for all zones (optimized for heatmap rendering)
 */
router.get('/current', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const heatmapData = getHeatmapData();
    
    res.json({
      success: true,
      ...heatmapData
    });
  } catch (error: any) {
    logger.error('Error fetching current heatmap', { error: error.message });
    next(error);
  }
});

/**
 * GET /api/heatmap/prices
 * Get current prices (detailed)
 */
router.get('/prices', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const prices = getCurrentPrices();
    
    const priceArray = Array.from(prices.entries()).map(([zoneId, data]) => ({
      zoneId,
      price: data.price,
      demand: data.demand,
      supply: data.supply,
      congestion: data.congestion,
      timestamp: data.timestamp.toISOString()
    }));
    
    res.json({
      success: true,
      prices: priceArray,
      count: priceArray.length,
      timestamp: new Date().toISOString()
    });
  } catch (error: any) {
    logger.error('Error fetching prices', { error: error.message });
    next(error);
  }
});

/**
 * GET /api/heatmap/historical
 * Get historical price snapshots
 */
router.get('/historical', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { startTime, endTime, zoneIds } = req.query;
    
    const query: any = {};
    
    if (startTime) {
      query.startTime = new Date(startTime as string);
    }
    
    if (endTime) {
      query.endTime = new Date(endTime as string);
    }
    
    if (zoneIds) {
      query.zoneIds = (zoneIds as string).split(',');
    }
    
    const snapshots = getHistoricalPrices(query);
    
    const formatted = snapshots.map(snapshot => ({
      timestamp: snapshot.timestamp.toISOString(),
      prices: Object.fromEntries(snapshot.zones)
    }));
    
    res.json({
      success: true,
      snapshots: formatted,
      count: formatted.length
    });
  } catch (error: any) {
    logger.error('Error fetching historical data', { error: error.message });
    next(error);
  }
});

/**
 * GET /api/heatmap/zones/:zoneId/stats
 * Get price statistics for a zone
 */
router.get('/zones/:zoneId/stats', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { zoneId } = req.params;
    const { startTime, endTime } = req.query;
    
    const stats = getZonePriceStats(
      zoneId,
      startTime ? new Date(startTime as string) : undefined,
      endTime ? new Date(endTime as string) : undefined
    );
    
    res.json({
      success: true,
      zoneId,
      stats: {
        minPrice: stats.minPrice.toFixed(4),
        maxPrice: stats.maxPrice.toFixed(4),
        avgPrice: stats.avgPrice.toFixed(4),
        currentPrice: stats.currentPrice.toFixed(4),
        priceRange: (stats.maxPrice - stats.minPrice).toFixed(4),
        volatility: stats.avgPrice > 0 
          ? ((stats.maxPrice - stats.minPrice) / stats.avgPrice * 100).toFixed(2) + '%'
          : '0%'
      }
    });
  } catch (error: any) {
    logger.error('Error fetching zone stats', { error: error.message });
    next(error);
  }
});

/**
 * GET /api/heatmap/regions
 * Get list of all regions
 */
router.get('/regions', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const zones = getAllZones();
    const regions = new Set(zones.map(z => z.region));
    
    const regionData = Array.from(regions).map(region => {
      const regionZones = zones.filter(z => z.region === region);
      const prices = getCurrentPrices();
      
      const regionPrices = regionZones
        .map(z => prices.get(z.id)?.price || z.basePrice)
        .filter(p => p > 0);
      
      const avgPrice = regionPrices.length > 0
        ? regionPrices.reduce((a, b) => a + b, 0) / regionPrices.length
        : 0;
      
      return {
        name: region,
        zonesCount: regionZones.length,
        avgPrice: avgPrice.toFixed(4),
        totalPopulation: regionZones.reduce((sum, z) => sum + z.population, 0)
      };
    });
    
    res.json({
      success: true,
      regions: regionData,
      count: regionData.length
    });
  } catch (error: any) {
    logger.error('Error fetching regions', { error: error.message });
    next(error);
  }
});

/**
 * GET /api/heatmap/summary
 * Get overall heatmap summary statistics
 */
router.get('/summary', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const zones = getAllZones();
    const prices = getCurrentPrices();
    
    const priceValues = Array.from(prices.values()).map(p => p.price);
    
    const minPrice = Math.min(...priceValues);
    const maxPrice = Math.max(...priceValues);
    const avgPrice = priceValues.reduce((a, b) => a + b, 0) / priceValues.length;
    
    // Calculate distribution
    const ranges = [
      { label: 'Low', min: 0, max: avgPrice * 0.9, count: 0 },
      { label: 'Normal', min: avgPrice * 0.9, max: avgPrice * 1.1, count: 0 },
      { label: 'High', min: avgPrice * 1.1, max: Infinity, count: 0 }
    ];
    
    priceValues.forEach(price => {
      for (const range of ranges) {
        if (price >= range.min && price < range.max) {
          range.count++;
          break;
        }
      }
    });
    
    res.json({
      success: true,
      summary: {
        totalZones: zones.length,
        priceStats: {
          min: minPrice.toFixed(4),
          max: maxPrice.toFixed(4),
          avg: avgPrice.toFixed(4),
          range: (maxPrice - minPrice).toFixed(4)
        },
        distribution: ranges.map(r => ({
          label: r.label,
          count: r.count,
          percentage: ((r.count / priceValues.length) * 100).toFixed(1) + '%'
        })),
        timestamp: new Date().toISOString()
      }
    });
  } catch (error: any) {
    logger.error('Error fetching summary', { error: error.message });
    next(error);
  }
});

export default router;
