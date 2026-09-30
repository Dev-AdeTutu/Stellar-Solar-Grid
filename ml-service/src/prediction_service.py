"""
Prediction service for load forecasting
Provides REST API for multi-horizon predictions
"""

from flask import Flask, request, jsonify
from flask_cors import CORS
from datetime import datetime, timedelta
import pandas as pd
import numpy as np
import os
import logging
from typing import Dict, List, Optional
from prometheus_client import Counter, Histogram, generate_latest
import time

from model import LoadForecastingModel
from preprocessing import DataPreprocessor

# Configure logging
logging.basicConfig(
    level=logging.INFO,
    format='%(asctime)s - %(name)s - %(levelname)s - %(message)s'
)
logger = logging.getLogger(__name__)

# Prometheus metrics
prediction_counter = Counter(
    'load_forecast_predictions_total',
    'Total number of predictions made',
    ['horizon']
)

prediction_latency = Histogram(
    'load_forecast_prediction_latency_seconds',
    'Prediction latency in seconds',
    ['horizon']
)

# Initialize Flask app
app = Flask(__name__)
CORS(app)

# Global model instance
model: Optional[LoadForecastingModel] = None
preprocessor: Optional[DataPreprocessor] = None
model_metadata: Dict = {}


def load_model(model_dir: str = './models/latest'):
    """
    Load trained model
    
    Args:
        model_dir: Directory containing trained model
    """
    global model, preprocessor, model_metadata
    
    logger.info(f"Loading model from {model_dir}")
    
    try:
        model = LoadForecastingModel()
        model.load(model_dir)
        
        # Load metadata
        import joblib
        metadata_path = os.path.join(model_dir, 'metadata.pkl')
        model_metadata = joblib.load(metadata_path)
        
        preprocessor = DataPreprocessor()
        
        logger.info("Model loaded successfully")
        logger.info(f"Horizons: {model.horizons}")
        logger.info(f"Features: {len(model.feature_names)}")
        
        return True
    except Exception as e:
        logger.error(f"Error loading model: {e}")
        return False


def get_recent_data(hours: int = 168) -> pd.DataFrame:
    """
    Get recent load data for prediction
    
    Args:
        hours: Number of hours of recent data to fetch
        
    Returns:
        DataFrame with recent data
    """
    # In production, this would fetch from database
    # For now, generate synthetic data
    end_time = datetime.now()
    start_time = end_time - timedelta(hours=hours)
    
    # Generate synthetic recent data
    load_df = preprocessor.generate_synthetic_load_data(
        start_date=start_time,
        end_date=end_time,
        base_load=1000.0
    )
    
    # Get weather data
    weather_df = preprocessor.fetch_weather_data(
        lat=37.7749,
        lon=-122.4194,
        start_date=start_time,
        end_date=end_time
    )
    
    # Preprocess
    df = preprocessor.prepare_training_data(
        load_df=load_df,
        weather_df=weather_df,
        target_column='load'
    )
    
    return df


@app.route('/health', methods=['GET'])
def health_check():
    """Health check endpoint"""
    return jsonify({
        'status': 'healthy',
        'model_loaded': model is not None,
        'timestamp': datetime.now().isoformat()
    })


@app.route('/model/info', methods=['GET'])
def model_info():
    """Get model information"""
    if model is None:
        return jsonify({'error': 'Model not loaded'}), 503
    
    return jsonify({
        'horizons': model.horizons,
        'sequence_length': model.sequence_length,
        'n_features': model.n_features,
        'features': model.feature_names,
        'metadata': model_metadata
    })


@app.route('/forecast', methods=['POST'])
def forecast():
    """
    Generate load forecast
    
    Request body:
    {
        "horizon": 1,  // or 24, 168
        "recent_data": [...],  // optional, otherwise fetched from DB
        "timestamp": "2024-01-01T00:00:00"  // optional, defaults to now
    }
    
    Response:
    {
        "horizon": 1,
        "predictions": [1234.5, ...],
        "timestamps": ["2024-01-01T01:00:00", ...],
        "metadata": {...}
    }
    """
    if model is None:
        return jsonify({'error': 'Model not loaded'}), 503
    
    try:
        data = request.get_json()
        horizon = data.get('horizon', 24)
        
        if horizon not in model.horizons:
            return jsonify({
                'error': f'Invalid horizon. Must be one of {model.horizons}'
            }), 400
        
        start_time = time.time()
        
        # Get recent data
        if 'recent_data' in data:
            # Use provided data
            recent_df = pd.DataFrame(data['recent_data'])
        else:
            # Fetch from database
            recent_df = get_recent_data(hours=model.sequence_length)
        
        # Make prediction
        predictions = model.predict(recent_df, horizon)
        
        # Generate timestamps for predictions
        base_time = datetime.fromisoformat(
            data.get('timestamp', datetime.now().isoformat())
        )
        timestamps = [
            (base_time + timedelta(hours=i+1)).isoformat()
            for i in range(len(predictions))
        ]
        
        # Record metrics
        latency = time.time() - start_time
        prediction_counter.labels(horizon=horizon).inc()
        prediction_latency.labels(horizon=horizon).observe(latency)
        
        return jsonify({
            'horizon': horizon,
            'predictions': predictions.tolist(),
            'timestamps': timestamps,
            'metadata': {
                'prediction_time': datetime.now().isoformat(),
                'latency_seconds': latency,
                'base_timestamp': base_time.isoformat()
            }
        })
        
    except Exception as e:
        logger.error(f"Error generating forecast: {e}")
        return jsonify({'error': str(e)}), 500


@app.route('/forecast/all', methods=['POST'])
def forecast_all_horizons():
    """
    Generate forecasts for all horizons
    
    Request body:
    {
        "recent_data": [...],  // optional
        "timestamp": "2024-01-01T00:00:00"  // optional
    }
    
    Response:
    {
        "forecasts": {
            "1": {"predictions": [...], "timestamps": [...]},
            "24": {"predictions": [...], "timestamps": [...]},
            "168": {"predictions": [...], "timestamps": [...]}
        },
        "metadata": {...}
    }
    """
    if model is None:
        return jsonify({'error': 'Model not loaded'}), 503
    
    try:
        data = request.get_json() or {}
        
        start_time = time.time()
        
        # Get recent data
        if 'recent_data' in data:
            recent_df = pd.DataFrame(data['recent_data'])
        else:
            recent_df = get_recent_data(hours=model.sequence_length)
        
        # Make predictions for all horizons
        predictions_dict = model.predict_all_horizons(recent_df)
        
        # Generate timestamps
        base_time = datetime.fromisoformat(
            data.get('timestamp', datetime.now().isoformat())
        )
        
        forecasts = {}
        for horizon, predictions in predictions_dict.items():
            timestamps = [
                (base_time + timedelta(hours=i+1)).isoformat()
                for i in range(len(predictions))
            ]
            
            forecasts[str(horizon)] = {
                'predictions': predictions.tolist(),
                'timestamps': timestamps
            }
            
            prediction_counter.labels(horizon=horizon).inc()
        
        latency = time.time() - start_time
        
        return jsonify({
            'forecasts': forecasts,
            'metadata': {
                'prediction_time': datetime.now().isoformat(),
                'latency_seconds': latency,
                'base_timestamp': base_time.isoformat(),
                'horizons': model.horizons
            }
        })
        
    except Exception as e:
        logger.error(f"Error generating forecasts: {e}")
        return jsonify({'error': str(e)}), 500


@app.route('/forecast/batch', methods=['POST'])
def forecast_batch():
    """
    Generate forecasts for multiple timestamps
    
    Request body:
    {
        "horizon": 24,
        "timestamps": ["2024-01-01T00:00:00", "2024-01-02T00:00:00"],
        "recent_data": {...}  // optional
    }
    """
    if model is None:
        return jsonify({'error': 'Model not loaded'}), 503
    
    try:
        data = request.get_json()
        horizon = data.get('horizon', 24)
        timestamps = data.get('timestamps', [])
        
        if horizon not in model.horizons:
            return jsonify({
                'error': f'Invalid horizon. Must be one of {model.horizons}'
            }), 400
        
        if not timestamps:
            return jsonify({'error': 'No timestamps provided'}), 400
        
        results = []
        
        for timestamp_str in timestamps:
            # Get recent data for this timestamp
            if 'recent_data' in data:
                recent_df = pd.DataFrame(data['recent_data'])
            else:
                recent_df = get_recent_data(hours=model.sequence_length)
            
            # Make prediction
            predictions = model.predict(recent_df, horizon)
            
            base_time = datetime.fromisoformat(timestamp_str)
            pred_timestamps = [
                (base_time + timedelta(hours=i+1)).isoformat()
                for i in range(len(predictions))
            ]
            
            results.append({
                'base_timestamp': timestamp_str,
                'predictions': predictions.tolist(),
                'timestamps': pred_timestamps
            })
        
        return jsonify({
            'horizon': horizon,
            'results': results,
            'metadata': {
                'prediction_time': datetime.now().isoformat(),
                'count': len(results)
            }
        })
        
    except Exception as e:
        logger.error(f"Error generating batch forecasts: {e}")
        return jsonify({'error': str(e)}), 500


@app.route('/metrics', methods=['GET'])
def metrics():
    """Prometheus metrics endpoint"""
    return generate_latest()


@app.route('/reload', methods=['POST'])
def reload_model():
    """Reload model from disk"""
    try:
        model_dir = request.get_json().get('model_dir', './models/latest')
        success = load_model(model_dir)
        
        if success:
            return jsonify({
                'status': 'success',
                'message': 'Model reloaded successfully'
            })
        else:
            return jsonify({
                'status': 'error',
                'message': 'Failed to reload model'
            }), 500
            
    except Exception as e:
        return jsonify({'error': str(e)}), 500


def main():
    """Main entry point"""
    import argparse
    
    parser = argparse.ArgumentParser(description='Load Forecasting Prediction Service')
    parser.add_argument('--model-dir', type=str, default='./models/latest',
                        help='Directory containing trained model')
    parser.add_argument('--host', type=str, default='0.0.0.0',
                        help='Host to bind to')
    parser.add_argument('--port', type=int, default=5000,
                        help='Port to bind to')
    
    args = parser.parse_args()
    
    # Load model
    if not load_model(args.model_dir):
        logger.error("Failed to load model. Exiting.")
        return
    
    # Start server
    logger.info(f"Starting prediction service on {args.host}:{args.port}")
    app.run(host=args.host, port=args.port, debug=False)


if __name__ == '__main__':
    main()
