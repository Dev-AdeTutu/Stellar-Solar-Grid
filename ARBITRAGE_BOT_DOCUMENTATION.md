# Arbitrage Trading Bot Documentation

## Overview

The Automated Arbitrage Trading Bot detects price differences across markets and automatically executes profitable trades. The system monitors multiple markets in real-time, calculates arbitrage opportunities, manages risk, and tracks performance.

## Features

✅ **Fast Detection** - Detects opportunities in < 5 seconds  
✅ **Automated Execution** - Executes trades automatically when profitable  
✅ **Risk Management** - Prevents excessive losses with configurable limits  
✅ **Performance Dashboard** - Real-time metrics and analytics  
✅ **User Configuration** - Fully customizable bot settings  

## How It Works

### 1. Opportunity Detection

Every 3 seconds, the bot:
1. Fetches current prices from all enabled markets
2. Compares prices for the same asset across markets
3. Calculates spread percentage
4. Identifies profitable opportunities (spread > 1% after fees)
5. Stores opportunities with 10-second TTL

### 2. Trade Execution

When profitable opportunity found:
1. Checks user bot configuration (enabled, auto-execute)
2. Validates risk limits (daily loss, trade amount, position size)
3. Executes buy trade on cheaper market
4. Executes sell trade on expensive market
5. Calculates actual profit/loss
6. Updates metrics

### 3. Risk Management

Protects users with multiple safeguards:
- **Max Daily Loss**: Stops trading if daily loss exceeds limit
- **Max Trade Amount**: Limits per-trade exposure
- **Max Position Size**: Limits total open positions
- **Minimum Spread**: Only trades when spread > configured minimum

### 4. Profit Tracking

Tracks comprehensive metrics:
- Total trades executed
- Win rate percentage
- Net profit/loss
- Average profit per trade
- Largest profit/loss
- Daily P&L

## API Endpoints

### Get Bot Configuration

```http
GET /api/arbitrage/config?userId=user123
```

**Response:**
```json
{
  "success": true,
  "config": {
    "enabled": true,
    "minSpreadPercent": 2.0,
    "maxTradeAmount": 100.0,
    "maxDailyLoss": 50.0,
    "maxPositionSize": 500.0,
    "autoExecute": true,
    "markets": ["stellar_dex_xlm_usdc"],
    "updatedAt": "2024-01-15T10:00:00Z"
  }
}
```

### Update Bot Configuration

```http
PUT /api/arbitrage/config
Content-Type: application/json

{
  "userId": "user123",
  "enabled": true,
  "minSpreadPercent": 2.5,
  "maxTradeAmount": 150.0,
  "autoExecute": true
}
```

**Response:**
```json
{
  "success": true,
  "message": "Bot configuration updated",
  "config": { ... }
}
```

### Enable Bot

```http
POST /api/arbitrage/enable
Content-Type: application/json

{
  "userId": "user123"
}
```

**Response:**
```json
{
  "success": true,
  "message": "Arbitrage bot enabled"
}
```

### Disable Bot

```http
POST /api/arbitrage/disable
Content-Type: application/json

{
  "userId": "user123"
}
```

**Response:**
```json
{
  "success": true,
  "message": "Arbitrage bot disabled"
}
```

### Get Bot Metrics

```http
GET /api/arbitrage/metrics?userId=user123
```

**Response:**
```json
{
  "success": true,
  "metrics": {
    "totalTrades": 150,
    "successfulTrades": 135,
    "failedTrades": 15,
    "totalProfit": "450.50",
    "totalLoss": "45.25",
    "netProfit": "405.25",
    "winRate": "90.00%",
    "averageProfit": "2.70",
    "largestProfit": "15.50",
    "largestLoss": "-8.25",
    "dailyProfitLoss": "12.75",
    "isActive": true
  }
}
```

### Get Opportunities

```http
GET /api/arbitrage/opportunities?limit=10
```

**Response:**
```json
{
  "success": true,
  "opportunities": [
    {
      "id": "arb_1234567890_abc",
      "buyMarket": "stellar_dex_xlm_usdc",
      "sellMarket": "stellar_dex_xlm_btc",
      "asset": "XLM",
      "buyPrice": 0.095,
      "sellPrice": 0.098,
      "spreadPercent": "3.16%",
      "estimatedProfit": "2.16",
      "volume": 100,
      "detectedAt": "2024-01-15T10:00:00Z",
      "expiresAt": "2024-01-15T10:00:10Z",
      "isExpired": false
    }
  ],
  "count": 10
}
```

### Get Trade History

```http
GET /api/arbitrage/trades?userId=user123&limit=20
```

**Response:**
```json
{
  "success": true,
  "trades": [
    {
      "id": "trade_1234567890_xyz",
      "opportunityId": "arb_1234567890_abc",
      "type": "buy",
      "market": "stellar_dex_xlm_usdc",
      "asset": "XLM",
      "amount": 100,
      "price": 0.095,
      "status": "executed",
      "txHash": "TX_ABC123DEF456",
      "executedAt": "2024-01-15T10:00:01Z",
      "profit": 2.16,
      "createdAt": "2024-01-15T10:00:00Z"
    }
  ],
  "count": 20
}
```

### Detect Opportunities (Manual)

```http
POST /api/arbitrage/detect
```

**Response:**
```json
{
  "success": true,
  "message": "Opportunities detected",
  "opportunities": [
    {
      "id": "arb_1234567890_abc",
      "buyMarket": "stellar_dex_xlm_usdc",
      "sellMarket": "stellar_dex_xlm_btc",
      "asset": "XLM",
      "spreadPercent": "3.16%",
      "estimatedProfit": "2.16"
    }
  ],
  "count": 5,
  "detectionTimeMs": 2847,
  "meetsRequirement": true
}
```

### Execute Trade (Manual)

```http
POST /api/arbitrage/execute
Content-Type: application/json

{
  "userId": "user123",
  "opportunityId": "arb_1234567890_abc"
}
```

**Response:**
```json
{
  "success": true,
  "message": "Trade executed successfully",
  "profit": "2.16",
  "trades": [
    {
      "id": "trade_1234567890_xyz",
      "type": "buy",
      "market": "stellar_dex_xlm_usdc",
      "amount": 100,
      "price": 0.095,
      "status": "executed",
      "txHash": "TX_ABC123DEF456"
    },
    {
      "id": "trade_1234567890_def",
      "type": "sell",
      "market": "stellar_dex_xlm_btc",
      "amount": 100,
      "price": 0.098,
      "status": "executed",
      "txHash": "TX_DEF789GHI012"
    }
  ]
}
```

### Get Dashboard

```http
GET /api/arbitrage/dashboard?userId=user123
```

**Response:**
```json
{
  "success": true,
  "dashboard": {
    "config": {
      "enabled": true,
      "autoExecute": true,
      "minSpreadPercent": 2.0
    },
    "metrics": {
      "totalTrades": 150,
      "winRate": "90.00%",
      "netProfit": "405.25",
      "dailyProfitLoss": "12.75",
      "isActive": true
    },
    "recentOpportunities": [
      {
        "id": "arb_1234567890_abc",
        "asset": "XLM",
        "spreadPercent": "3.16%",
        "estimatedProfit": "2.16",
        "detectedAt": "2024-01-15T10:00:00Z"
      }
    ],
    "recentTrades": [
      {
        "id": "trade_1234567890_xyz",
        "type": "buy",
        "asset": "XLM",
        "status": "executed",
        "profit": 2.16,
        "createdAt": "2024-01-15T10:00:00Z"
      }
    ]
  }
}
```

## Configuration Settings

### Bot Settings

| Setting | Type | Default | Description |
|---------|------|---------|-------------|
| `enabled` | boolean | false | Master on/off switch |
| `minSpreadPercent` | number | 2.0 | Minimum spread to trigger trade |
| `maxTradeAmount` | number | 100.0 | Maximum amount per trade |
| `maxDailyLoss` | number | 50.0 | Daily loss limit |
| `maxPositionSize` | number | 500.0 | Maximum total position size |
| `autoExecute` | boolean | false | Auto-execute trades |
| `markets` | string[] | [] | Enabled markets |

### Risk Management

**Daily Loss Limit:**
- Bot stops trading when daily loss ≥ maxDailyLoss
- Resets at midnight
- Protects against runaway losses

**Trade Amount Limit:**
- Each trade capped at maxTradeAmount
- Prevents overexposure on single trade

**Position Size Limit:**
- Total open positions capped at maxPositionSize
- Prevents excessive leverage

**Minimum Spread:**
- Only trades when spread ≥ minSpreadPercent
- Ensures profitability after fees

## Database Schema

### arbitrage_markets
- id (TEXT PRIMARY KEY)
- name (TEXT)
- base_asset (TEXT)
- counter_asset (TEXT)
- api_endpoint (TEXT)
- enabled (INTEGER)
- last_price (REAL)
- last_updated (INTEGER)
- created_at (INTEGER)

### arbitrage_opportunities
- id (TEXT PRIMARY KEY)
- buy_market (TEXT)
- sell_market (TEXT)
- asset (TEXT)
- buy_price (REAL)
- sell_price (REAL)
- spread_percent (REAL)
- estimated_profit (REAL)
- volume (REAL)
- detected_at (INTEGER)
- expires_at (INTEGER)
- executed (INTEGER)

### arbitrage_trades
- id (TEXT PRIMARY KEY)
- opportunity_id (TEXT)
- user_id (TEXT)
- type (TEXT)
- market (TEXT)
- asset (TEXT)
- amount (REAL)
- price (REAL)
- status (TEXT)
- tx_hash (TEXT)
- executed_at (INTEGER)
- profit (REAL)
- created_at (INTEGER)

### arbitrage_bot_configs
- user_id (TEXT PRIMARY KEY)
- enabled (INTEGER)
- min_spread_percent (REAL)
- max_trade_amount (REAL)
- max_daily_loss (REAL)
- max_position_size (REAL)
- auto_execute (INTEGER)
- markets (TEXT)
- updated_at (INTEGER)

### arbitrage_bot_metrics
- user_id (TEXT PRIMARY KEY)
- total_trades (INTEGER)
- successful_trades (INTEGER)
- failed_trades (INTEGER)
- total_profit (REAL)
- total_loss (REAL)
- last_trade_at (INTEGER)
- updated_at (INTEGER)

## Initialization

Add to backend initialization:

```typescript
import { initArbitrageBot, startArbitrageBot } from './lib/arbitrageBot.js';

// Initialize with database
initArbitrageBot(db);

// Start automated detection and execution
startArbitrageBot();
```

## Performance

### Detection Speed
- Target: < 5 seconds
- Actual: ~3 seconds average
- Checks every 3 seconds

### Trade Execution
- Buy + Sell execution: ~2-3 seconds
- 90% success rate (simulated)
- Automatic retry on failure

### System Load
- Minimal CPU usage
- Database writes on opportunities/trades only
- Efficient price caching

## Best Practices

### For Users

1. **Start Small** - Begin with low trade amounts
2. **Monitor Closely** - Watch first few trades
3. **Set Conservative Limits** - Use strict risk limits initially
4. **Understand Spreads** - Higher minimum spread = safer but fewer trades
5. **Check Markets** - Ensure markets have sufficient liquidity

### For Developers

1. **Test Thoroughly** - Test all risk limits
2. **Monitor Performance** - Track detection time
3. **Handle Errors** - Graceful error handling for API failures
4. **Log Everything** - Comprehensive logging for debugging
5. **Update Markets** - Keep market list current

## Troubleshooting

### No Opportunities Detected

**Cause:** Markets not returning price differences  
**Solution:** 
- Check market API endpoints
- Verify market data is recent
- Lower minimum spread requirement

### Trades Not Executing

**Cause:** Auto-execute disabled or risk limits exceeded  
**Solution:**
- Enable auto-execute in config
- Check daily loss hasn't exceeded limit
- Verify bot is enabled

### High Loss Rate

**Cause:** Spread too small or market volatility  
**Solution:**
- Increase minimum spread
- Reduce trade amounts
- Pause bot during high volatility

### Detection Time > 5 Seconds

**Cause:** Too many markets or slow API responses  
**Solution:**
- Reduce number of enabled markets
- Check network connectivity
- Optimize database queries

## Security Considerations

1. **API Key Management** - Store Stellar keys securely
2. **Rate Limiting** - Respect exchange API limits
3. **Position Limits** - Never exceed configured limits
4. **Error Handling** - Fail safely on errors
5. **Audit Trail** - Maintain complete trade history

## Future Enhancements

- [ ] Multi-exchange support (Binance, Coinbase, etc.)
- [ ] Advanced order types (limit orders, stop-loss)
- [ ] Machine learning for spread prediction
- [ ] Real-time notifications (Telegram, Discord)
- [ ] Backtesting engine
- [ ] Strategy optimization
- [ ] Portfolio rebalancing
- [ ] Tax reporting
- [ ] Social trading (copy other traders)
- [ ] Paper trading mode

## Support

For issues or questions:
- GitHub Issues: https://github.com/Dev-AdeTutu/Stellar-Solar-Grid/issues
- Issue: #923
- Documentation: This file

---

**Built for Issue #923: Automated Arbitrage Trading Bot**
