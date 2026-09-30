# Load Forecasting ML Service API Documentation

## Overview

The Load Forecasting ML Service provides machine learning-based predictions for energy demand across multiple time horizons. The service uses LSTM neural networks trained on historical load data and weather information to generate accurate forecasts.

## Base URL

```
http://localhost:5000
```

## Authentication

Currently, the API does not require authentication. In production, implement API key-based authentication or OAuth2.

## Endpoints

### Health Check

Check the health status of the ML service.

**Endpoint:** `GET /health`

**Response:**
```json
{
  "status": "healthy",
  "model_loaded": true,
  "timestamp": "2024-01-01T00:00:00"
}
```

---

### Model Information

Get information about the loaded model, including supported horizons and features.

**Endpoint:** `GET /model/info`

**Response:**
```json
{
  "horizons": [1, 24, 168],
  "sequence_length": 168,
  "n_features": 45,
  "features": [
    "hour", "day_of_week", "month", "temperature",
    "humidity", "wind_speed", "clouds", "pressure",
    "hour_sin", "hour_cos", "dow_sin", "dow_cos",
    "is_weekend", "is_business_hour", ...
  ],
  "metadata": {
    "timestamp": "2024-01-01T00:00:00",
    "sequence_length": 168,
    "n_features": 45,
    "horizons": [1, 24, 168]
  }
}
```

---

### Generate Forecast (Single Horizon)

Generate load forecast for a specific time horizon.

**Endpoint:** `POST /forecast`

**Request Body:**
```json
{
  "horizon": 24,
  "timestamp": "2024-01-01T00:00:00",
  "recent_data": []
}
```

**Parameters:**
- `horizon` (required): Forecast horizon in hours. Must be one of: `1`, `24`, or `168`
- `timestamp` (optional): Base timestamp for predictions. Defaults to current time
- `recent_data` (optional): Array of recent data points. If not provided, fetched from database

**Response:**
```json
{
  "horizon": 24,
  "predictions": [1234.5, 1256.3, 1289.7, ...],
  "timestamps": [
    "2024-01-01T01:00:00",
    "2024-01-01T02:00:00",
    "2024-01-01T03:00:00",
    ...
  ],
  "metadata": {
    "prediction_time": "2024-01-01T00:00:00",
    "latency_seconds": 0.234,
    "base_timestamp": "2024-01-01T00:00:00"
  }
}
```

**Example cURL:**
```bash
curl -X POST http://localhost:5000/forecast \
  -H "Content-Type: application/json" \
  -d '{
    "horizon": 24,
    "timestamp": "2024-01-01T00:00:00"
  }'
```

---

### Generate All Horizons Forecast

Generate forecasts for all supported time horizons (1h, 24h, 168h).

**Endpoint:** `POST /forecast/all`

**Request Body:**
```json
{
  "timestamp": "2024-01-01T00:00:00",
  "recent_data": []
}
```

**Parameters:**
- `timestamp` (optional): Base timestamp for predictions
- `recent_data` (optional): Recent data for prediction context

**Response:**
```json
{
  "forecasts": {
    "1": {
      "predictions": [1234.5],
      "timestamps": ["2024-01-01T01:00:00"]
    },
    "24": {
      "predictions": [1234.5, 1256.3, ...],
      "timestamps": ["2024-01-01T01:00:00", "2024-01-01T02:00:00", ...]
    },
    "168": {
      "predictions": [1234.5, 1256.3, ...],
      "timestamps": ["2024-01-01T01:00:00", ...]
    }
  },
  "metadata": {
    "prediction_time": "2024-01-01T00:00:00",
    "latency_seconds": 0.567,
    "base_timestamp": "2024-01-01T00:00:00",
    "horizons": [1, 24, 168]
  }
}
```

**Example cURL:**
```bash
curl -X POST http://localhost:5000/forecast/all \
  -H "Content-Type: application/json" \
  -d '{
    "timestamp": "2024-01-01T00:00:00"
  }'
```

---

### Batch Forecast

Generate forecasts for multiple timestamps in a single request.

**Endpoint:** `POST /forecast/batch`

**Request Body:**
```json
{
  "horizon": 24,
  "timestamps": [
    "2024-01-01T00:00:00",
    "2024-01-02T00:00:00",
    "2024-01-03T00:00:00"
  ],
  "recent_data": {}
}
```

**Parameters:**
- `horizon` (required): Forecast horizon in hours
- `timestamps` (required): Array of base timestamps
- `recent_data` (optional): Recent data context

**Response:**
```json
{
  "horizon": 24,
  "results": [
    {
      "base_timestamp": "2024-01-01T00:00:00",
      "predictions": [1234.5, 1256.3, ...],
      "timestamps": ["2024-01-01T01:00:00", ...]
    },
    {
      "base_timestamp": "2024-01-02T00:00:00",
      "predictions": [1245.2, 1267.8, ...],
      "timestamps": ["2024-01-02T01:00:00", ...]
    }
  ],
  "metadata": {
    "prediction_time": "2024-01-01T00:00:00",
    "count": 3
  }
}
```

---

### Reload Model

Reload the ML model from disk (useful after retraining).

**Endpoint:** `POST /reload`

**Request Body:**
```json
{
  "model_dir": "./models/latest"
}
```

**Parameters:**
- `model_dir` (optional): Path to model directory. Defaults to `./models/latest`

**Response:**
```json
{
  "status": "success",
  "message": "Model reloaded successfully"
}
```

---

### Prometheus Metrics

Get Prometheus-compatible metrics for monitoring.

**Endpoint:** `GET /metrics`

**Response:** Plain text Prometheus metrics format

**Metrics Exposed:**
- `load_forecast_predictions_total`: Counter of total predictions made (labeled by horizon)
- `load_forecast_prediction_latency_seconds`: Histogram of prediction latency (labeled by horizon)

---

## Node.js Backend API Integration

The Node.js backend provides a proxy layer to the ML service with additional features.

### Base URL
```
http://localhost:3001/api/forecast
```

### Endpoints

#### Health Check
```
GET /api/forecast/health
```

#### Model Info
```
GET /api/forecast/model/info
```

#### Generate Forecast
```
POST /api/forecast
```

#### All Horizons
```
POST /api/forecast/all
```

#### Batch Forecast
```
POST /api/forecast/batch
```

#### Reload Model
```
POST /api/forecast/reload
```

#### Metrics
```
GET /api/forecast/metrics
```

All endpoints have the same request/response format as the ML service.

---

## Error Responses

### 400 Bad Request
```json
{
  "error": "Invalid horizon",
  "message": "Horizon must be one of: 1, 24, 168"
}
```

### 500 Internal Server Error
```json
{
  "error": "Error generating forecast: ...",
  "details": "..."
}
```

### 503 Service Unavailable
```json
{
  "error": "Model not loaded"
}
```

---

## Model Training

### Training Script

Train the model using the command-line interface:

```bash
python src/train.py \
  --data-path ./data/historical_load.csv \
  --model-dir ./models/latest \
  --epochs 100 \
  --batch-size 32 \
  --validation-split 0.2 \
  --test-split 0.1 \
  --weather-api-key YOUR_API_KEY \
  --lat 37.7749 \
  --lon -122.4194
```

**Arguments:**
- `--data-path`: Path to historical load data (CSV or SQLite database)
- `--model-dir`: Directory to save trained models
- `--epochs`: Number of training epochs (default: 100)
- `--batch-size`: Batch size for training (default: 32)
- `--validation-split`: Validation split ratio (default: 0.2)
- `--test-split`: Test split ratio (default: 0.1)
- `--weather-api-key`: OpenWeatherMap API key
- `--lat`: Latitude for weather data
- `--lon`: Longitude for weather data

### Training Output

The training script generates:
- Trained models for each horizon
- `test_results.json`: Model evaluation metrics
- `training_history.json`: Training history
- `training_summary.json`: Summary of training run

---

## Automated Retraining

### Scheduler Service

Run the automated retraining scheduler:

```bash
python src/scheduler.py \
  --model-dir ./models \
  --data-path ./data/historical_load.csv \
  --cron "0 2 * * 0" \
  --weather-api-key YOUR_API_KEY
```

**Arguments:**
- `--model-dir`: Base directory for models
- `--data-path`: Path to training data
- `--cron`: Cron schedule (default: Every Sunday at 2 AM)
- `--weather-api-key`: Weather API key
- `--run-now`: Run retraining immediately on startup

**Default Schedule:** Every Sunday at 2:00 AM

---

## Performance Metrics

### Model Accuracy

The model is trained to achieve:
- **>90% accuracy** for 24-hour forecasts
- High accuracy across all horizons (1h, 24h, 168h)

### Prediction Latency

Typical prediction latencies:
- Single horizon: < 0.5 seconds
- All horizons: < 1 second
- Batch requests: ~0.3 seconds per timestamp

---

## Weather Integration

The service integrates weather data to improve forecast accuracy:

**Weather Features:**
- Temperature (°C)
- Humidity (%)
- Wind speed (m/s)
- Cloud coverage (%)
- Atmospheric pressure (hPa)

**Weather API:** OpenWeatherMap (configurable)

---

## Feature Engineering

The model uses extensive feature engineering:

**Time-based Features:**
- Hour of day (cyclical encoding)
- Day of week (cyclical encoding)
- Month, quarter, year
- Is weekend
- Is business hour
- Season indicators

**Lag Features:**
- Load lags: 1h, 2h, 3h, 24h, 48h, 168h

**Rolling Statistics:**
- Rolling mean, std, min, max
- Windows: 3h, 6h, 12h, 24h, 168h

**Weather Features:**
- Raw weather variables
- Heat index
- Temperature-humidity interaction

---

## Deployment

### Docker Deployment

```bash
docker build -t load-forecasting-service .
docker run -p 5000:5000 \
  -e WEATHER_API_KEY=your_key \
  -v $(pwd)/models:/app/models \
  load-forecasting-service
```

### Production Considerations

1. **Authentication**: Implement API key or OAuth2 authentication
2. **Rate Limiting**: Add rate limiting to prevent abuse
3. **Caching**: Cache recent predictions for frequently requested timestamps
4. **Monitoring**: Set up Prometheus + Grafana for monitoring
5. **Load Balancing**: Deploy multiple instances behind a load balancer
6. **Data Pipeline**: Automated pipeline for fetching and preprocessing training data
7. **Model Versioning**: Track model versions and performance metrics
8. **Alerting**: Set up alerts for model accuracy degradation

---

## Support

For issues or questions, contact the development team or open an issue on GitHub.

**Repository:** https://github.com/Dev-AdeTutu/Stellar-Solar-Grid
**Issue:** #930
