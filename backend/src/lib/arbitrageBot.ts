/**
 * Automated Arbitrage Trading Bot
 * Detects and executes profitable arbitrage opportunities across markets
 */

import Database from 'better-sqlite3';
import { logger } from './logger.js';
import * as StellarSdk from '@stellar/stellar-sdk';
import { stellarService } from './stellar.js';

export interface Market {
  id: string;
  name: string;
  baseAsset: string;
  counterAsset: string;
  apiEndpoint: string;
  enabled: boolean;
}

export interface ArbitrageOpportunity {
  id: string;
  buyMarket: string;
  sellMarket: string;
  asset: string;
  buyPrice: number;
  sellPrice: number;
  spreadPercent: number;
  estimatedProfit: number;
  volume: number;
  detectedAt: Date;
  expiresAt: Date;
}

export interface Trade {
  id: string;
  opportunityId: string;
  userId: string;
  type: 'buy' | 'sell';
  market: string;
  asset: string;
  amount: number;
  price: number;
  status: 'pending' | 'executed' | 'failed' | 'cancelled';
  txHash?: string;
  executedAt?: Date;
  profit?: number;
  createdAt: Date;
}

export interface BotConfig {
  userId: string;
  enabled: boolean;
  minSpreadPercent: number;
  maxTradeAmount: number;
  maxDailyLoss: number;
  maxPositionSize: number;
  autoExecute: boolean;
  markets: string[];
  updatedAt: Date;
}

export interface BotMetrics {
  userId: string;
  totalTrades: number;
  successfulTrades: number;
  failedTrades: number;
  totalProfit: number;
  totalLoss: number;
  netProfit: number;
  winRate: number;
  averageProfit: number;
  largestProfit: number;
  largestLoss: number;
  dailyProfitLoss: number;
  isActive: boolean;
}

let db: Database.Database;
let detectionInterval: NodeJS.Timeout | null = null;
const DETECTION_INTERVAL_MS = 3000; // 3 seconds (< 5 second requirement)
const OPPORTUNITY_TTL_MS = 10000; // 10 seconds

/**
 * Initialize arbitrage bot system
 */
export function initArbitrageBot(database: Database.Database): void {
  db = database;
  
  // Create tables
  db.exec(`
    CREATE TABLE IF NOT EXISTS arbitrage_markets (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      base_asset TEXT NOT NULL,
      counter_asset TEXT NOT NULL,
      api_endpoint TEXT NOT NULL,
      enabled INTEGER DEFAULT 1,
      last_price REAL,
      last_updated INTEGER,
      created_at INTEGER NOT NULL
    );

    CREATE TABLE IF NOT EXISTS arbitrage_opportunities (
      id TEXT PRIMARY KEY,
      buy_market TEXT NOT NULL,
      sell_market TEXT NOT NULL,
      asset TEXT NOT NULL,
      buy_price REAL NOT NULL,
      sell_price REAL NOT NULL,
      spread_percent REAL NOT NULL,
      estimated_profit REAL NOT NULL,
      volume REAL NOT NULL,
      detected_at INTEGER NOT NULL,
      expires_at INTEGER NOT NULL,
      executed INTEGER DEFAULT 0
    );

    CREATE TABLE IF NOT EXISTS arbitrage_trades (
      id TEXT PRIMARY KEY,
      opportunity_id TEXT,
      user_id TEXT NOT NULL,
      type TEXT NOT NULL,
      market TEXT NOT NULL,
      asset TEXT NOT NULL,
      amount REAL NOT NULL,
      price REAL NOT NULL,
      status TEXT NOT NULL,
      tx_hash TEXT,
      executed_at INTEGER,
      profit REAL,
      created_at INTEGER NOT NULL,
      FOREIGN KEY (opportunity_id) REFERENCES arbitrage_opportunities(id)
    );

    CREATE TABLE IF NOT EXISTS arbitrage_bot_configs (
      user_id TEXT PRIMARY KEY,
      enabled INTEGER DEFAULT 0,
      min_spread_percent REAL DEFAULT 2.0,
      max_trade_amount REAL DEFAULT 100.0,
      max_daily_loss REAL DEFAULT 50.0,
      max_position_size REAL DEFAULT 500.0,
      auto_execute INTEGER DEFAULT 0,
      markets TEXT DEFAULT '[]',
      updated_at INTEGER NOT NULL
    );

    CREATE TABLE IF NOT EXISTS arbitrage_bot_metrics (
      user_id TEXT PRIMARY KEY,
      total_trades INTEGER DEFAULT 0,
      successful_trades INTEGER DEFAULT 0,
      failed_trades INTEGER DEFAULT 0,
      total_profit REAL DEFAULT 0,
      total_loss REAL DEFAULT 0,
      last_trade_at INTEGER,
      updated_at INTEGER NOT NULL
    );

    CREATE INDEX IF NOT EXISTS idx_opportunities_detected 
      ON arbitrage_opportunities(detected_at);
    CREATE INDEX IF NOT EXISTS idx_opportunities_spread 
      ON arbitrage_opportunities(spread_percent);
    CREATE INDEX IF NOT EXISTS idx_trades_user 
      ON arbitrage_trades(user_id);
    CREATE INDEX IF NOT EXISTS idx_trades_status 
      ON arbitrage_trades(status);
  `);

  // Initialize default markets (Stellar DEX)
  initializeDefaultMarkets();

  logger.info('Arbitrage bot system initialized');
}

/**
 * Initialize default markets
 */
function initializeDefaultMarkets(): void {
  const defaultMarkets = [
    {
      id: 'stellar_dex_xlm_usdc',
      name: 'Stellar DEX XLM/USDC',
      baseAsset: 'XLM',
      counterAsset: 'USDC',
      apiEndpoint: 'https://horizon.stellar.org'
    },
    {
      id: 'stellar_dex_xlm_btc',
      name: 'Stellar DEX XLM/BTC',
      baseAsset: 'XLM',
      counterAsset: 'BTC',
      apiEndpoint: 'https://horizon.stellar.org'
    }
  ];

  const insert = db.prepare(`
    INSERT OR IGNORE INTO arbitrage_markets 
    (id, name, base_asset, counter_asset, api_endpoint, created_at)
    VALUES (?, ?, ?, ?, ?, ?)
  `);

  for (const market of defaultMarkets) {
    insert.run(
      market.id,
      market.name,
      market.baseAsset,
      market.counterAsset,
      market.apiEndpoint,
      Date.now()
    );
  }
}

/**
 * Fetch current market prices
 */
async function fetchMarketPrices(): Promise<Map<string, number>> {
  const prices = new Map<string, number>();
  
  try {
    const markets = db.prepare(`
      SELECT * FROM arbitrage_markets WHERE enabled = 1
    `).all() as any[];

    for (const market of markets) {
      try {
        // Fetch from Stellar DEX
        const server = new StellarSdk.Horizon.Server(market.api_endpoint);
        
        // Get orderbook
        const orderbook = await server
          .orderbook(
            new StellarSdk.Asset(market.base_asset, market.base_asset === 'XLM' ? undefined : 'issuer'),
            new StellarSdk.Asset(market.counter_asset, market.counter_asset === 'USDC' ? 'issuer' : undefined)
          )
          .call();

        // Get best bid (highest buy price)
        const bestBid = orderbook.bids[0]?.price 
          ? parseFloat(orderbook.bids[0].price) 
          : 0;

        // Get best ask (lowest sell price)
        const bestAsk = orderbook.asks[0]?.price 
          ? parseFloat(orderbook.asks[0].price) 
          : 0;

        // Use mid price
        const midPrice = (bestBid + bestAsk) / 2;

        if (midPrice > 0) {
          prices.set(market.id, midPrice);
          
          // Update last price in database
          db.prepare(`
            UPDATE arbitrage_markets 
            SET last_price = ?, last_updated = ? 
            WHERE id = ?
          `).run(midPrice, Date.now(), market.id);
        }
      } catch (error) {
        logger.error('Error fetching market price', { 
          market: market.id, 
          error 
        });
      }
    }
  } catch (error) {
    logger.error('Error fetching market prices', { error });
  }

  return prices;
}

/**
 * Detect arbitrage opportunities
 */
export async function detectArbitrageOpportunities(): Promise<ArbitrageOpportunity[]> {
  const startTime = Date.now();
  const opportunities: ArbitrageOpportunity[] = [];

  try {
    // Fetch current prices for all markets
    const prices = await fetchMarketPrices();

    // Get all enabled markets
    const markets = db.prepare(`
      SELECT * FROM arbitrage_markets WHERE enabled = 1
    `).all() as any[];

    // Compare prices across markets for same asset
    for (let i = 0; i < markets.length; i++) {
      for (let j = i + 1; j < markets.length; j++) {
        const market1 = markets[i];
        const market2 = markets[j];

        // Only compare if they trade the same base asset
        if (market1.base_asset !== market2.base_asset) continue;

        const price1 = prices.get(market1.id);
        const price2 = prices.get(market2.id);

        if (!price1 || !price2 || price1 === price2) continue;

        // Determine buy/sell markets
        const buyMarket = price1 < price2 ? market1 : market2;
        const sellMarket = price1 < price2 ? market2 : market1;
        const buyPrice = Math.min(price1, price2);
        const sellPrice = Math.max(price1, price2);

        // Calculate spread
        const spreadPercent = ((sellPrice - buyPrice) / buyPrice) * 100;

        // Minimum spread to be profitable (accounting for fees)
        if (spreadPercent < 1.0) continue;

        // Estimate volume (simplified - would query orderbook in production)
        const volume = 100; // Placeholder

        // Estimate profit (minus 0.5% fees on both sides)
        const feePercent = 1.0; // 0.5% buy + 0.5% sell
        const estimatedProfit = (spreadPercent - feePercent) * volume;

        const opportunity: ArbitrageOpportunity = {
          id: `arb_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`,
          buyMarket: buyMarket.id,
          sellMarket: sellMarket.id,
          asset: buyMarket.base_asset,
          buyPrice,
          sellPrice,
          spreadPercent,
          estimatedProfit,
          volume,
          detectedAt: new Date(),
          expiresAt: new Date(Date.now() + OPPORTUNITY_TTL_MS)
        };

        // Save to database
        db.prepare(`
          INSERT INTO arbitrage_opportunities 
          (id, buy_market, sell_market, asset, buy_price, sell_price, 
           spread_percent, estimated_profit, volume, detected_at, expires_at)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        `).run(
          opportunity.id,
          opportunity.buyMarket,
          opportunity.sellMarket,
          opportunity.asset,
          opportunity.buyPrice,
          opportunity.sellPrice,
          opportunity.spreadPercent,
          opportunity.estimatedProfit,
          opportunity.volume,
          opportunity.detectedAt.getTime(),
          opportunity.expiresAt.getTime()
        );

        opportunities.push(opportunity);
      }
    }

    const detectionTime = Date.now() - startTime;
    
    if (opportunities.length > 0) {
      logger.info('Arbitrage opportunities detected', { 
        count: opportunities.length,
        detectionTimeMs: detectionTime
      });
    }

    // Verify detection time < 5 seconds
    if (detectionTime > 5000) {
      logger.warn('Detection time exceeded 5 seconds', { detectionTime });
    }

  } catch (error) {
    logger.error('Error detecting arbitrage opportunities', { error });
  }

  return opportunities;
}

/**
 * Execute arbitrage trade
 */
export async function executeTrade(
  userId: string,
  opportunityId: string
): Promise<{ success: boolean; trades: Trade[]; profit?: number }> {
  try {
    // Get opportunity
    const opp = db.prepare(`
      SELECT * FROM arbitrage_opportunities WHERE id = ?
    `).get(opportunityId) as any;

    if (!opp) {
      return { success: false, trades: [] };
    }

    // Check if already executed
    if (opp.executed) {
      return { success: false, trades: [] };
    }

    // Check if expired
    if (Date.now() > opp.expires_at) {
      return { success: false, trades: [] };
    }

    // Get user config
    const config = getUserConfig(userId);
    if (!config.enabled || !config.autoExecute) {
      return { success: false, trades: [] };
    }

    // Check risk limits
    const canTrade = checkRiskLimits(userId, opp.estimated_profit);
    if (!canTrade) {
      logger.warn('Trade blocked by risk limits', { userId, opportunityId });
      return { success: false, trades: [] };
    }

    const trades: Trade[] = [];

    // Execute buy trade
    const buyTrade = await executeSingleTrade(
      userId,
      opportunityId,
      'buy',
      opp.buy_market,
      opp.asset,
      opp.volume,
      opp.buy_price
    );
    trades.push(buyTrade);

    if (buyTrade.status === 'executed') {
      // Execute sell trade
      const sellTrade = await executeSingleTrade(
        userId,
        opportunityId,
        'sell',
        opp.sell_market,
        opp.asset,
        opp.volume,
        opp.sell_price
      );
      trades.push(sellTrade);

      if (sellTrade.status === 'executed') {
        // Calculate actual profit
        const buyValue = buyTrade.amount * buyTrade.price;
        const sellValue = sellTrade.amount * sellTrade.price;
        const fees = (buyValue + sellValue) * 0.005; // 0.5% each side
        const profit = sellValue - buyValue - fees;

        // Mark opportunity as executed
        db.prepare(`
          UPDATE arbitrage_opportunities SET executed = 1 WHERE id = ?
        `).run(opportunityId);

        // Update metrics
        updateMetrics(userId, profit, true);

        logger.info('Arbitrage trade executed successfully', {
          userId,
          opportunityId,
          profit
        });

        return { success: true, trades, profit };
      }
    }

    // If we get here, one or both trades failed
    updateMetrics(userId, 0, false);
    return { success: false, trades };

  } catch (error) {
    logger.error('Error executing arbitrage trade', { userId, opportunityId, error });
    return { success: false, trades: [] };
  }
}

/**
 * Execute a single trade
 */
async function executeSingleTrade(
  userId: string,
  opportunityId: string,
  type: 'buy' | 'sell',
  market: string,
  asset: string,
  amount: number,
  price: number
): Promise<Trade> {
  const tradeId = `trade_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;
  
  const trade: Trade = {
    id: tradeId,
    opportunityId,
    userId,
    type,
    market,
    asset,
    amount,
    price,
    status: 'pending',
    createdAt: new Date()
  };

  // Save trade to database
  db.prepare(`
    INSERT INTO arbitrage_trades 
    (id, opportunity_id, user_id, type, market, asset, amount, price, status, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    trade.id,
    trade.opportunityId,
    trade.userId,
    trade.type,
    trade.market,
    trade.asset,
    trade.amount,
    trade.price,
    trade.status,
    trade.createdAt.getTime()
  );

  try {
    // In production, this would execute actual Stellar transaction
    // For now, simulate success
    const simulatedSuccess = Math.random() > 0.1; // 90% success rate

    if (simulatedSuccess) {
      const txHash = `TX_${Math.random().toString(36).substr(2, 16).toUpperCase()}`;
      trade.status = 'executed';
      trade.txHash = txHash;
      trade.executedAt = new Date();

      // Update database
      db.prepare(`
        UPDATE arbitrage_trades 
        SET status = ?, tx_hash = ?, executed_at = ? 
        WHERE id = ?
      `).run('executed', txHash, trade.executedAt.getTime(), trade.id);
    } else {
      trade.status = 'failed';
      db.prepare(`
        UPDATE arbitrage_trades SET status = ? WHERE id = ?
      `).run('failed', trade.id);
    }
  } catch (error) {
    logger.error('Trade execution failed', { tradeId, error });
    trade.status = 'failed';
    db.prepare(`
      UPDATE arbitrage_trades SET status = ? WHERE id = ?
    `).run('failed', trade.id);
  }

  return trade;
}

/**
 * Check risk limits
 */
function checkRiskLimits(userId: string, estimatedProfit: number): boolean {
  const config = getUserConfig(userId);
  const metrics = getBotMetrics(userId);

  // Check daily loss limit
  if (metrics.dailyProfitLoss < -config.maxDailyLoss) {
    return false;
  }

  // Check if trade amount within limits
  if (Math.abs(estimatedProfit) > config.maxTradeAmount) {
    return false;
  }

  return true;
}

/**
 * Update bot metrics
 */
function updateMetrics(userId: string, profit: number, success: boolean): void {
  const now = Date.now();
  
  db.prepare(`
    INSERT INTO arbitrage_bot_metrics 
    (user_id, total_trades, successful_trades, failed_trades, 
     total_profit, total_loss, last_trade_at, updated_at)
    VALUES (?, 1, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(user_id) DO UPDATE SET
      total_trades = total_trades + 1,
      successful_trades = successful_trades + ?,
      failed_trades = failed_trades + ?,
      total_profit = total_profit + ?,
      total_loss = total_loss + ?,
      last_trade_at = ?,
      updated_at = ?
  `).run(
    userId,
    success ? 1 : 0,
    success ? 0 : 1,
    profit > 0 ? profit : 0,
    profit < 0 ? Math.abs(profit) : 0,
    now,
    now,
    success ? 1 : 0,
    success ? 0 : 1,
    profit > 0 ? profit : 0,
    profit < 0 ? Math.abs(profit) : 0,
    now,
    now
  );
}

/**
 * Get user bot configuration
 */
export function getUserConfig(userId: string): BotConfig {
  let config = db.prepare(`
    SELECT * FROM arbitrage_bot_configs WHERE user_id = ?
  `).get(userId) as any;

  if (!config) {
    // Create default config
    const now = Date.now();
    db.prepare(`
      INSERT INTO arbitrage_bot_configs (user_id, updated_at)
      VALUES (?, ?)
    `).run(userId, now);

    config = db.prepare(`
      SELECT * FROM arbitrage_bot_configs WHERE user_id = ?
    `).get(userId) as any;
  }

  return {
    userId: config.user_id,
    enabled: config.enabled === 1,
    minSpreadPercent: config.min_spread_percent,
    maxTradeAmount: config.max_trade_amount,
    maxDailyLoss: config.max_daily_loss,
    maxPositionSize: config.max_position_size,
    autoExecute: config.auto_execute === 1,
    markets: JSON.parse(config.markets || '[]'),
    updatedAt: new Date(config.updated_at)
  };
}

/**
 * Update user bot configuration
 */
export function updateUserConfig(userId: string, updates: Partial<BotConfig>): void {
  const current = getUserConfig(userId);
  
  const newConfig = { ...current, ...updates, updatedAt: new Date() };

  db.prepare(`
    UPDATE arbitrage_bot_configs 
    SET enabled = ?, min_spread_percent = ?, max_trade_amount = ?,
        max_daily_loss = ?, max_position_size = ?, auto_execute = ?,
        markets = ?, updated_at = ?
    WHERE user_id = ?
  `).run(
    newConfig.enabled ? 1 : 0,
    newConfig.minSpreadPercent,
    newConfig.maxTradeAmount,
    newConfig.maxDailyLoss,
    newConfig.maxPositionSize,
    newConfig.autoExecute ? 1 : 0,
    JSON.stringify(newConfig.markets),
    newConfig.updatedAt.getTime(),
    userId
  );

  logger.info('Bot configuration updated', { userId });
}

/**
 * Get bot metrics for user
 */
export function getBotMetrics(userId: string): BotMetrics {
  const metrics = db.prepare(`
    SELECT * FROM arbitrage_bot_metrics WHERE user_id = ?
  `).get(userId) as any;

  if (!metrics) {
    return {
      userId,
      totalTrades: 0,
      successfulTrades: 0,
      failedTrades: 0,
      totalProfit: 0,
      totalLoss: 0,
      netProfit: 0,
      winRate: 0,
      averageProfit: 0,
      largestProfit: 0,
      largestLoss: 0,
      dailyProfitLoss: 0,
      isActive: false
    };
  }

  const netProfit = metrics.total_profit - metrics.total_loss;
  const winRate = metrics.total_trades > 0 
    ? (metrics.successful_trades / metrics.total_trades) * 100 
    : 0;
  const averageProfit = metrics.total_trades > 0 
    ? netProfit / metrics.total_trades 
    : 0;

  // Get largest profit/loss
  const profitTrades = db.prepare(`
    SELECT MAX(profit) as max_profit, MIN(profit) as max_loss
    FROM arbitrage_trades
    WHERE user_id = ? AND status = 'executed'
  `).get(userId) as any;

  // Get today's profit/loss
  const dayStart = new Date();
  dayStart.setHours(0, 0, 0, 0);
  
  const dailyResult = db.prepare(`
    SELECT SUM(profit) as daily_pnl
    FROM arbitrage_trades
    WHERE user_id = ? AND status = 'executed' AND executed_at >= ?
  `).get(userId, dayStart.getTime()) as any;

  const config = getUserConfig(userId);

  return {
    userId,
    totalTrades: metrics.total_trades,
    successfulTrades: metrics.successful_trades,
    failedTrades: metrics.failed_trades,
    totalProfit: metrics.total_profit,
    totalLoss: metrics.total_loss,
    netProfit,
    winRate,
    averageProfit,
    largestProfit: profitTrades?.max_profit || 0,
    largestLoss: profitTrades?.max_loss || 0,
    dailyProfitLoss: dailyResult?.daily_pnl || 0,
    isActive: config.enabled
  };
}

/**
 * Get recent opportunities
 */
export function getRecentOpportunities(limit: number = 50): ArbitrageOpportunity[] {
  const rows = db.prepare(`
    SELECT * FROM arbitrage_opportunities
    ORDER BY detected_at DESC
    LIMIT ?
  `).all(limit) as any[];

  return rows.map(row => ({
    id: row.id,
    buyMarket: row.buy_market,
    sellMarket: row.sell_market,
    asset: row.asset,
    buyPrice: row.buy_price,
    sellPrice: row.sell_price,
    spreadPercent: row.spread_percent,
    estimatedProfit: row.estimated_profit,
    volume: row.volume,
    detectedAt: new Date(row.detected_at),
    expiresAt: new Date(row.expires_at)
  }));
}

/**
 * Get user trade history
 */
export function getUserTrades(userId: string, limit: number = 50): Trade[] {
  const rows = db.prepare(`
    SELECT * FROM arbitrage_trades
    WHERE user_id = ?
    ORDER BY created_at DESC
    LIMIT ?
  `).all(userId, limit) as any[];

  return rows.map(row => ({
    id: row.id,
    opportunityId: row.opportunity_id,
    userId: row.user_id,
    type: row.type,
    market: row.market,
    asset: row.asset,
    amount: row.amount,
    price: row.price,
    status: row.status,
    txHash: row.tx_hash,
    executedAt: row.executed_at ? new Date(row.executed_at) : undefined,
    profit: row.profit,
    createdAt: new Date(row.created_at)
  }));
}

/**
 * Start automated detection and execution
 */
export function startArbitrageBot(): void {
  if (detectionInterval) {
    logger.warn('Arbitrage bot already running');
    return;
  }

  detectionInterval = setInterval(async () => {
    try {
      // Detect opportunities
      const opportunities = await detectArbitrageOpportunities();

      if (opportunities.length > 0) {
        // Get all users with auto-execute enabled
        const users = db.prepare(`
          SELECT user_id FROM arbitrage_bot_configs
          WHERE enabled = 1 AND auto_execute = 1
        `).all() as any[];

        // Execute trades for each user
        for (const user of users) {
          for (const opp of opportunities) {
            const config = getUserConfig(user.user_id);
            
            // Check if spread meets minimum
            if (opp.spreadPercent >= config.minSpreadPercent) {
              await executeTrade(user.user_id, opp.id);
            }
          }
        }
      }
    } catch (error) {
      logger.error('Error in arbitrage bot cycle', { error });
    }
  }, DETECTION_INTERVAL_MS);

  logger.info('Arbitrage bot started', { intervalMs: DETECTION_INTERVAL_MS });
}

/**
 * Stop arbitrage bot
 */
export function stopArbitrageBot(): void {
  if (detectionInterval) {
    clearInterval(detectionInterval);
    detectionInterval = null;
    logger.info('Arbitrage bot stopped');
  }
}
