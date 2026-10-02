# Demand Response Program Documentation

## Overview

The Demand Response Program rewards users for reducing their energy consumption during peak demand periods. The system automatically detects peak conditions, notifies users in advance, tracks participation, calculates rewards, and provides comprehensive analytics.

## Features

✅ **Peak Demand Detection** - Automatically detects when grid demand approaches capacity  
✅ **Advance Notifications** - Sends push notifications 1 hour before peak events  
✅ **Reward Calculation** - Calculates rewards based on consumption reduction  
✅ **Participation Tracking** - Maintains complete participation history  
✅ **Program Analytics** - Provides ROI metrics and program performance data  

## How It Works

### 1. Peak Detection

The system monitors total grid demand every 15 minutes:
- Calculates demand ratio: `current_demand / estimated_capacity`
- When ratio ≥ 85%, creates a peak event
- Schedules event to start 1 hour later
- Event duration: 2 hours

### 2. User Notification

When peak event is created:
- Push notifications sent to all eligible users
- Message: "Peak demand period starting in 1 hour. Reduce usage to earn rewards!"
- Includes event details (start time, end time)

### 3. Baseline Calculation

For each meter, baseline consumption is calculated as:
- Average consumption during same hours
- Based on previous 5-7 days
- Accounts for normal usage patterns

### 4. Reward Calculation

After event completes:
- **Actual consumption** measured during event period
- **Reduction** = Baseline - Actual
- **Qualifies** if reduction ≥ 10% of baseline
- **Reward** = Reduction (kWh) × $0.50/kWh

### 5. Reward Distribution

Qualifying participants receive:
- Monetary reward credited to account
- Push notification with reward details
- Entry in participation history

## API Endpoints

### Get Program Statistics

```http
GET /api/demand-response/stats
```

**Response:**
```json
{
  "success": true,
  "stats": {
    "totalEvents": 25,
    "activeParticipants": 150,
    "totalReductionKwh": 3450.5,
    "totalRewardsDistributed": 1725.25,
    "averageParticipationRate": "65.00%",
    "roi": "125.50%",
    "programHealth": "positive"
  }
}
```

### Get Peak Events

```http
GET /api/demand-response/events?status=completed&limit=10
```

**Query Parameters:**
- `status` (optional): Filter by status (scheduled, active, completed, cancelled)
- `limit` (optional): Maximum number of events (default: 50)

**Response:**
```json
{
  "success": true,
  "events": [
    {
      "id": "peak_1234567890",
      "startTime": "2024-01-15T14:00:00Z",
      "endTime": "2024-01-15T16:00:00Z",
      "predictedDemand": 4500.0,
      "threshold": 4250.0,
      "status": "completed",
      "notificationsSent": true,
      "createdAt": "2024-01-15T13:00:00Z"
    }
  ],
  "count": 10
}
```

### Get Event Details

```http
GET /api/demand-response/events/{eventId}
```

**Response:**
```json
{
  "success": true,
  "event": {
    "id": "peak_1234567890",
    "startTime": "2024-01-15T14:00:00Z",
    "endTime": "2024-01-15T16:00:00Z",
    "predictedDemand": 4500.0,
    "threshold": 4250.0,
    "status": "completed",
    "notificationsSent": true,
    "createdAt": "2024-01-15T13:00:00Z"
  },
  "participants": {
    "count": 95,
    "totalReduction": 285.5,
    "totalRewards": 142.75
  }
}
```

### Get Participation History

```http
GET /api/demand-response/participation/{meterId}
```

**Response:**
```json
{
  "success": true,
  "meterId": "METER_123",
  "history": [
    {
      "peakEventId": "peak_1234567890",
      "baselineConsumption": 5.2,
      "actualConsumption": 3.8,
      "reduction": 1.4,
      "rewardAmount": 0.70,
      "participatedAt": "2024-01-15T16:00:00Z"
    }
  ],
  "summary": {
    "participationCount": 15,
    "totalReductionKwh": 22.5,
    "totalRewardsEarned": 11.25,
    "averageRewardPerEvent": "0.75"
  }
}
```

### Trigger Peak Detection (Admin)

```http
POST /api/demand-response/detect
Authorization: X-Admin-Key: <admin_key>
```

**Response:**
```json
{
  "success": true,
  "message": "Peak demand detected and notifications sent",
  "peakDetected": true,
  "event": {
    "id": "peak_1234567890",
    "startTime": "2024-01-15T15:00:00Z",
    "endTime": "2024-01-15T17:00:00Z",
    "predictedDemand": 4500.0,
    "threshold": 4250.0
  },
  "notificationsSent": 150
}
```

### Process Event Participation (Admin)

```http
POST /api/demand-response/events/{eventId}/process
Authorization: X-Admin-Key: <admin_key>
```

**Response:**
```json
{
  "success": true,
  "message": "Participation processed",
  "results": {
    "participantCount": 95,
    "totalReductionKwh": 285.5,
    "totalRewardsDistributed": 142.75
  }
}
```

### Update Event Status (Admin)

```http
PUT /api/demand-response/events/{eventId}/status
Authorization: X-Admin-Key: <admin_key>
Content-Type: application/json

{
  "status": "cancelled"
}
```

**Response:**
```json
{
  "success": true,
  "message": "Event status updated",
  "eventId": "peak_1234567890",
  "newStatus": "cancelled"
}
```

### Get Leaderboard

```http
GET /api/demand-response/leaderboard?limit=10
```

**Response:**
```json
{
  "success": true,
  "leaderboard": [
    {
      "rank": 1,
      "meterId": "METER_123",
      "owner": "user_abc",
      "participationCount": 20,
      "totalReductionKwh": 45.5,
      "totalRewards": 22.75
    }
  ]
}
```

### Get Analytics

```http
GET /api/demand-response/analytics?period=30d
```

**Query Parameters:**
- `period` (optional): Time period (7d, 30d, 90d) - default: 30d

**Response:**
```json
{
  "success": true,
  "period": "30d",
  "analytics": {
    "eventsByStatus": [
      { "status": "completed", "count": 20 },
      { "status": "active", "count": 1 },
      { "status": "scheduled", "count": 2 }
    ],
    "participationTrend": [
      {
        "date": "2024-01-15",
        "participants": 95,
        "reduction": 285.5,
        "rewards": 142.75
      }
    ],
    "hourlyDistribution": [
      { "hour": "14", "event_count": 8, "avg_demand": 4350.0 },
      { "hour": "15", "event_count": 10, "avg_demand": 4500.0 }
    ]
  }
}
```

## Configuration

### Environment Variables

```bash
# Peak detection threshold (0-1, default: 0.85)
PEAK_DEMAND_THRESHOLD=0.85

# Notification advance time in hours (default: 1)
NOTIFICATION_ADVANCE_HOURS=1

# Reward rate per kWh reduced (default: 0.50)
REWARD_RATE_PER_KWH=0.50

# Minimum reduction percentage to qualify (default: 10)
MIN_REDUCTION_PERCENTAGE=10

# Peak detection interval in minutes (default: 15)
PEAK_DETECTION_INTERVAL=15
```

### Database Schema

The system creates three tables:

**peak_events**
- id (TEXT PRIMARY KEY)
- start_time (INTEGER)
- end_time (INTEGER)
- predicted_demand (REAL)
- threshold (REAL)
- status (TEXT)
- notifications_sent (INTEGER)
- created_at (INTEGER)

**demand_response_participants**
- id (INTEGER PRIMARY KEY AUTOINCREMENT)
- meter_id (TEXT)
- peak_event_id (TEXT)
- baseline_consumption (REAL)
- actual_consumption (REAL)
- reduction (REAL)
- reward_amount (REAL)
- participated_at (INTEGER)

**demand_response_notifications**
- id (INTEGER PRIMARY KEY AUTOINCREMENT)
- meter_id (TEXT)
- peak_event_id (TEXT)
- notification_type (TEXT)
- sent_at (INTEGER)

## Initialization

Add to backend initialization:

```typescript
import { initDemandResponse, startPeakDetection } from './lib/demandResponse.js';

// Initialize with database
initDemandResponse(db);

// Start peak detection monitoring (every 15 minutes)
startPeakDetection(15);
```

## User Experience

### Notification Flow

1. **Advance Alert** (1 hour before)
   - Title: "⚡ Peak Demand Alert"
   - Body: "Peak demand period starting in 1 hour. Reduce usage to earn rewards!"

2. **Reward Notification** (after event)
   - Title: "🎉 Demand Response Reward Earned!"
   - Body: "You earned $X.XX for reducing consumption by X.XX kWh"

### Mobile App Integration

The mobile app should:
- Display upcoming peak events
- Show participation history
- Display total rewards earned
- Provide tips for reducing consumption
- Show leaderboard rankings

## ROI Calculation

The system calculates ROI as:

```
Savings = Total Reduction (kWh) × Grid Cost per kWh ($0.15)
ROI = ((Savings - Rewards Paid) / Rewards Paid) × 100%
```

**Example:**
- Total reduction: 1000 kWh
- Savings: 1000 × $0.15 = $150
- Rewards paid: $500 (1000 × $0.50)
- ROI: (($150 - $500) / $500) × 100% = -70%

A positive ROI means the program saves more than it costs.

## Best Practices

### For Grid Operators

1. **Set appropriate thresholds** - Adjust PEAK_DEMAND_THRESHOLD based on actual grid capacity
2. **Monitor participation rates** - Track participation trends and adjust incentives
3. **Communicate clearly** - Provide clear event information and expectations
4. **Analyze patterns** - Use analytics to identify optimal event timing
5. **Balance rewards** - Ensure rewards are attractive but sustainable

### For Users

1. **Enable notifications** - Subscribe to push notifications
2. **Plan ahead** - Use 1-hour advance notice to prepare
3. **Focus on high-impact actions**:
   - Delay high-consumption activities
   - Adjust thermostat settings
   - Turn off unnecessary appliances
4. **Track performance** - Monitor participation history
5. **Compete friendly** - Check leaderboard for motivation

## Troubleshooting

### No Peak Events Detected

- Check if grid demand is reaching threshold (85%)
- Verify peak detection is running: check logs
- Adjust PEAK_DEMAND_THRESHOLD if needed

### Notifications Not Sent

- Verify users have push subscriptions
- Check notification logs in database
- Ensure push service is configured

### Low Participation Rates

- Increase reward rate (REWARD_RATE_PER_KWH)
- Improve notification messaging
- Provide better user education
- Analyze event timing patterns

### Negative ROI

- Reduce reward rate
- Increase minimum reduction requirement
- Target events more carefully
- Consider dynamic pricing

## Future Enhancements

- [ ] Dynamic reward pricing based on demand severity
- [ ] Predictive ML models for better event forecasting
- [ ] Integration with weather forecasts
- [ ] Automated A/B testing of reward structures
- [ ] Gamification elements (badges, levels)
- [ ] Social features (team challenges)
- [ ] Smart home automation integration
- [ ] Real-time demand visualization
- [ ] Historical comparison analytics
- [ ] Custom event scheduling

## Support

For issues or questions:
- GitHub Issues: https://github.com/Dev-AdeTutu/Stellar-Solar-Grid/issues
- Issue: #924
- Documentation: This file

---

**Built for Issue #924: Demand Response Program**
