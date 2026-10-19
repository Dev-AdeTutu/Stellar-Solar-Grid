/**
 * Arbitrage Bot API Routes
 */

import express, { Request, Response, NextFunction } from 'express';
import {
  getUserConfig,
  updateUserConfig,
  getBotMetrics,
  getRecentOpportunities,
  getUserTrades,
  detectArbitrageOpportunities,
  executeTrade
} from '../lib/arbitrageBot.js';
import { logger } from '../lib/logger.js';

const router = express.Router();

/**
 * GET /api/arbitrage/config
 * Get user's bot configuration
 */
router.get('/config', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const userId = req.query.userId as string || 'default_user';
    
    const config = getUserConfig(userId);
    
    res.json({
      success: true,
      config: {
        enabled: config.enabled,
        minSpreadPercent: config.minSpreadPercent,
        maxTradeAmount: config.maxTradeAmount,
        maxDailyLoss: config.maxDailyLoss,
        maxPositionSize: config.maxPositionSize,
        autoExecute: config.autoExecute,
        markets: config.markets,
        updatedAt: config.updatedAt.toISOString()
      }
    });
  } catch (error: any) {
    logger.error('Error fetching bot config', { error: error.message });
    next(error);
  }
});

/**
 * PUT /api/arbitrage/config
 * Update user's bot configuration
 */
router.put('/config', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const userId = req.body.userId || 'default_user';
    const {
      enabled,
      minSpreadPercent,
      maxTradeAmount,
      maxDailyLoss,
      maxPositionSize,
      autoExecute,
      markets
    } = req.body;

    const updates: any = {};
    if (typeof enabled === 'boolean') updates.enabled = enabled;
    if (typeof minSpreadPercent === 'number') updates.minSpreadPercent = minSpreadPercent;
    if (typeof maxTradeAmount === 'number') updates.maxTradeAmount = maxTradeAmount;
    if (typeof maxDailyLoss === 'number') updates.maxDailyLoss = maxDailyLoss;
    if (typeof maxPositionSize === 'number') updates.maxPositionSize = maxPositionSize;
    if (typeof autoExecute === 'boolean') updates.autoExecute = autoExecute;
    if (Array.isArray(markets)) updates.markets = markets;

    updateUserConfig(userId, updates);

    const updatedConfig = getUserConfig(userId);

    res.json({
      success: true,
      message: 'Bot configuration updated',
      config: updatedConfig
    });
  } catch (error: any) {
    logger.error('Error updating bot config', { error: error.message });
    next(error);
  }
});

/**
 * POST /api/arbitrage/enable
 * Enable the bot for a user
 */
router.post('/enable', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const userId = req.body.userId || 'default_user';
    
    updateUserConfig(userId, { enabled: true });
    
    res.json({
      success: true,
      message: 'Arbitrage bot enabled'
    });
  } catch (error: any) {
    logger.error('Error enabling bot', { error: error.message });
    next(error);
  }
});

/**
 * POST /api/arbitrage/disable
 * Disable the bot for a user
 */
router.post('/disable', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const userId = req.body.userId || 'default_user';
    
    updateUserConfig(userId, { enabled: false });
    
    res.json({
      success: true,
      message: 'Arbitrage bot disabled'
    });
  } catch (error: any) {
    logger.error('Error disabling bot', { error: error.message });
    next(error);
  }
});

/**
 * GET /api/arbitrage/metrics
 * Get bot performance metrics
 */
router.get('/metrics', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const userId = req.query.userId as string || 'default_user';
    
    const metrics = getBotMetrics(userId);
    
    res.json({
      success: true,
      metrics: {
        totalTrades: metrics.totalTrades,
        successfulTrades: metrics.successfulTrades,
        failedTrades: metrics.failedTrades,
        totalProfit: metrics.totalProfit.toFixed(2),
        totalLoss: metrics.totalLoss.toFixed(2),
        netProfit: metrics.netProfit.toFixed(2),
        winRate: metrics.winRate.toFixed(2) + '%',
        averageProfit: metrics.averageProfit.toFixed(2),
        largestProfit: metrics.largestProfit.toFixed(2),
        largestLoss: metrics.largestLoss.toFixed(2),
        dailyProfitLoss: metrics.dailyProfitLoss.toFixed(2),
        isActive: metrics.isActive
      }
    });
  } catch (error: any) {
    logger.error('Error fetching metrics', { error: error.message });
    next(error);
  }
});

/**
 * GET /api/arbitrage/opportunities
 * Get recent arbitrage opportunities
 */
router.get('/opportunities', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const limit = parseInt(req.query.limit as string) || 50;
    
    const opportunities = getRecentOpportunities(limit);
    
    const formatted = opportunities.map(opp => ({
      id: opp.id,
      buyMarket: opp.buyMarket,
      sellMarket: opp.sellMarket,
      asset: opp.asset,
      buyPrice: opp.buyPrice,
      sellPrice: opp.sellPrice,
      spreadPercent: opp.spreadPercent.toFixed(2) + '%',
      estimatedProfit: opp.estimatedProfit.toFixed(2),
      volume: opp.volume,
      detectedAt: opp.detectedAt.toISOString(),
      expiresAt: opp.expiresAt.toISOString(),
      isExpired: Date.now() > opp.expiresAt.getTime()
    }));
    
    res.json({
      success: true,
      opportunities: formatted,
      count: formatted.length
    });
  } catch (error: any) {
    logger.error('Error fetching opportunities', { error: error.message });
    next(error);
  }
});

/**
 * GET /api/arbitrage/trades
 * Get user's trade history
 */
router.get('/trades', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const userId = req.query.userId as string || 'default_user';
    const limit = parseInt(req.query.limit as string) || 50;
    
    const trades = getUserTrades(userId, limit);
    
    const formatted = trades.map(trade => ({
      id: trade.id,
      opportunityId: trade.opportunityId,
      type: trade.type,
      market: trade.market,
      asset: trade.asset,
      amount: trade.amount,
      price: trade.price,
      status: trade.status,
      txHash: trade.txHash,
      executedAt: trade.executedAt?.toISOString(),
      profit: trade.profit,
      createdAt: trade.createdAt.toISOString()
    }));
    
    res.json({
      success: true,
      trades: formatted,
      count: formatted.length
    });
  } catch (error: any) {
    logger.error('Error fetching trades', { error: error.message });
    next(error);
  }
});

/**
 * POST /api/arbitrage/detect
 * Manually trigger opportunity detection
 */
router.post('/detect', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const startTime = Date.now();
    const opportunities = await detectArbitrageOpportunities();
    const detectionTime = Date.now() - startTime;
    
    res.json({
      success: true,
      message: 'Opportunities detected',
      opportunities: opportunities.map(opp => ({
        id: opp.id,
        buyMarket: opp.buyMarket,
        sellMarket: opp.sellMarket,
        asset: opp.asset,
        spreadPercent: opp.spreadPercent.toFixed(2) + '%',
        estimatedProfit: opp.estimatedProfit.toFixed(2)
      })),
      count: opportunities.length,
      detectionTimeMs: detectionTime,
      meetsRequirement: detectionTime < 5000
    });
  } catch (error: any) {
    logger.error('Error detecting opportunities', { error: error.message });
    next(error);
  }
});

/**
 * POST /api/arbitrage/execute
 * Manually execute trade for an opportunity
 */
router.post('/execute', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { userId, opportunityId } = req.body;
    
    if (!userId || !opportunityId) {
      return res.status(400).json({
        success: false,
        error: 'userId and opportunityId are required'
      });
    }
    
    const result = await executeTrade(userId, opportunityId);
    
    if (result.success) {
      res.json({
        success: true,
        message: 'Trade executed successfully',
        profit: result.profit?.toFixed(2),
        trades: result.trades.map(t => ({
          id: t.id,
          type: t.type,
          market: t.market,
          amount: t.amount,
          price: t.price,
          status: t.status,
          txHash: t.txHash
        }))
      });
    } else {
      res.status(400).json({
        success: false,
        message: 'Trade execution failed',
        trades: result.trades
      });
    }
  } catch (error: any) {
    logger.error('Error executing trade', { error: error.message });
    next(error);
  }
});

/**
 * GET /api/arbitrage/dashboard
 * Get complete dashboard data
 */
router.get('/dashboard', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const userId = req.query.userId as string || 'default_user';
    
    const config = getUserConfig(userId);
    const metrics = getBotMetrics(userId);
    const recentOpportunities = getRecentOpportunities(10);
    const recentTrades = getUserTrades(userId, 10);
    
    res.json({
      success: true,
      dashboard: {
        config: {
          enabled: config.enabled,
          autoExecute: config.autoExecute,
          minSpreadPercent: config.minSpreadPercent
        },
        metrics: {
          totalTrades: metrics.totalTrades,
          winRate: metrics.winRate.toFixed(2) + '%',
          netProfit: metrics.netProfit.toFixed(2),
          dailyProfitLoss: metrics.dailyProfitLoss.toFixed(2),
          isActive: metrics.isActive
        },
        recentOpportunities: recentOpportunities.slice(0, 5).map(opp => ({
          id: opp.id,
          asset: opp.asset,
          spreadPercent: opp.spreadPercent.toFixed(2) + '%',
          estimatedProfit: opp.estimatedProfit.toFixed(2),
          detectedAt: opp.detectedAt.toISOString()
        })),
        recentTrades: recentTrades.slice(0, 5).map(trade => ({
          id: trade.id,
          type: trade.type,
          asset: trade.asset,
          status: trade.status,
          profit: trade.profit,
          createdAt: trade.createdAt.toISOString()
        }))
      }
    });
  } catch (error: any) {
    logger.error('Error fetching dashboard', { error: error.message });
    next(error);
  }
});

export default router;
