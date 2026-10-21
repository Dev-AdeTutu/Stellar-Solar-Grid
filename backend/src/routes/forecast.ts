/**
 * Load Forecasting API Routes
 * Integrates with ML service for multi-horizon predictions
 */

import express, { Request, Response, NextFunction } from 'express';
import axios from 'axios';
import { logger } from '../lib/logger.js';

const router = express.Router();

// ML service configuration
const ML_SERVICE_URL = process.env.ML_SERVICE_URL || 'http://localhost:5000';
const ML_SERVICE_TIMEOUT = parseInt(process.env.ML_SERVICE_TIMEOUT || '30000');

interface ForecastRequest {
  horizon?: number;
  timestamp?: string;
  recent_data?: any[];
}

interface BatchForecastRequest {
  horizon: number;
  timestamps: string[];
  recent_data?: any;
}

/**
 * GET /api/forecast/health
 * Check ML service health
 */
router.get('/health', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const response = await axios.get(`${ML_SERVICE_URL}/health`, {
      timeout: 5000
    });
    
    res.json({
      ml_service: response.data,
      api_status: 'healthy'
    });
  } catch (error: any) {
    logger.error('ML service health check failed', { error: error.message });
    res.status(503).json({
      error: 'ML service unavailable',
      details: error.message
    });
  }
});

/**
 * GET /api/forecast/model/info
 * Get model information and capabilities
 */
router.get('/model/info', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const response = await axios.get(`${ML_SERVICE_URL}/model/info`, {
      timeout: 5000
    });
    
    res.json(response.data);
  } catch (error: any) {
    logger.error('Failed to get model info', { error: error.message });
    next(error);
  }
});

/**
 * POST /api/forecast
 * Generate load forecast for specific horizon
 * 
 * Body:
 * {
 *   "horizon": 1 | 24 | 168,
 *   "timestamp": "2024-01-01T00:00:00" (optional),
 *   "recent_data": [...] (optional)
 * }
 */
router.post('/', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { horizon = 24, timestamp, recent_data }: ForecastRequest = req.body;
    
    // Validate horizon
    const validHorizons = [1, 24, 168];
    if (!validHorizons.includes(horizon)) {
      return res.status(400).json({
        error: 'Invalid horizon',
        message: `Horizon must be one of: ${validHorizons.join(', ')}`
      });
    }
    
    logger.info('Generating forecast', { horizon, timestamp });
    
    const response = await axios.post(
      `${ML_SERVICE_URL}/forecast`,
      {
        horizon,
        timestamp,
        recent_data
      },
      {
        timeout: ML_SERVICE_TIMEOUT,
        headers: {
          'Content-Type': 'application/json'
        }
      }
    );
    
    res.json(response.data);
  } catch (error: any) {
    logger.error('Forecast generation failed', { 
      error: error.message,
      response: error.response?.data 
    });
    
    if (error.response) {
      return res.status(error.response.status).json(error.response.data);
    }
    
    next(error);
  }
});

/**
 * POST /api/forecast/all
 * Generate forecasts for all horizons (1h, 24h, 168h)
 * 
 * Body:
 * {
 *   "timestamp": "2024-01-01T00:00:00" (optional),
 *   "recent_data": [...] (optional)
 * }
 */
router.post('/all', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { timestamp, recent_data } = req.body;
    
    logger.info('Generating forecasts for all horizons', { timestamp });
    
    const response = await axios.post(
      `${ML_SERVICE_URL}/forecast/all`,
      {
        timestamp,
        recent_data
      },
      {
        timeout: ML_SERVICE_TIMEOUT,
        headers: {
          'Content-Type': 'application/json'
        }
      }
    );
    
    res.json(response.data);
  } catch (error: any) {
    logger.error('All horizons forecast failed', { 
      error: error.message,
      response: error.response?.data 
    });
    
    if (error.response) {
      return res.status(error.response.status).json(error.response.data);
    }
    
    next(error);
  }
});

/**
 * POST /api/forecast/batch
 * Generate forecasts for multiple timestamps
 * 
 * Body:
 * {
 *   "horizon": 24,
 *   "timestamps": ["2024-01-01T00:00:00", "2024-01-02T00:00:00"],
 *   "recent_data": {...} (optional)
 * }
 */
router.post('/batch', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { horizon, timestamps, recent_data }: BatchForecastRequest = req.body;
    
    if (!horizon || !timestamps || !Array.isArray(timestamps)) {
      return res.status(400).json({
        error: 'Invalid request',
        message: 'horizon and timestamps array are required'
      });
    }
    
    logger.info('Generating batch forecasts', { 
      horizon, 
      count: timestamps.length 
    });
    
    const response = await axios.post(
      `${ML_SERVICE_URL}/forecast/batch`,
      {
        horizon,
        timestamps,
        recent_data
      },
      {
        timeout: ML_SERVICE_TIMEOUT * 2, // Double timeout for batch
        headers: {
          'Content-Type': 'application/json'
        }
      }
    );
    
    res.json(response.data);
  } catch (error: any) {
    logger.error('Batch forecast failed', { 
      error: error.message,
      response: error.response?.data 
    });
    
    if (error.response) {
      return res.status(error.response.status).json(error.response.data);
    }
    
    next(error);
  }
});

/**
 * POST /api/forecast/reload
 * Reload ML model (admin only)
 */
router.post('/reload', async (req: Request, res: Response, next: NextFunction) => {
  try {
    // In production, add authentication/authorization middleware here
    
    const { model_dir } = req.body;
    
    logger.info('Reloading ML model', { model_dir });
    
    const response = await axios.post(
      `${ML_SERVICE_URL}/reload`,
      { model_dir },
      {
        timeout: 30000,
        headers: {
          'Content-Type': 'application/json'
        }
      }
    );
    
    res.json(response.data);
  } catch (error: any) {
    logger.error('Model reload failed', { 
      error: error.message,
      response: error.response?.data 
    });
    
    if (error.response) {
      return res.status(error.response.status).json(error.response.data);
    }
    
    next(error);
  }
});

/**
 * GET /api/forecast/metrics
 * Get ML service metrics (Prometheus format)
 */
router.get('/metrics', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const response = await axios.get(`${ML_SERVICE_URL}/metrics`, {
      timeout: 5000
    });
    
    res.set('Content-Type', 'text/plain');
    res.send(response.data);
  } catch (error: any) {
    logger.error('Failed to get metrics', { error: error.message });
    next(error);
  }
});

export default router;
