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
from federated_learning import FederatedCoordinator

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

# Global federated learning coordinator
federated_coordinator: Optional[FederatedCoordinator] = None


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


@app.route('/edge-model', methods=['GET', 'POST'])
def export_edge_model():
    """
    Export the current model for edge deployment

    Triggers export of the loaded model into an edge-deployable artifact
    (e.g. serialized weights + metadata) and returns the artifact path and
    version so the backend can fetch and deploy it to meter edge devices.

    Request body (optional):
    {
        "output_dir": "./models/edge",  // optional export directory
        "version": "1.0.0"              // optional explicit version
    }

    Response:
    {
        "status": "success",
        "artifact_path": "./models/edge/edge_model_1.0.0.pkl",
        "version": "1.0.0",
        "horizons": [1, 24, 168],
        "n_features": 12,
        "exported_at": "2024-01-01T00:00:00"
    }
    """
    if model is None:
        return jsonify({'error': 'Model not loaded'}), 503

    try:
        data = request.get_json(silent=True) or {}
        output_dir = data.get('output_dir', './models/edge')
        version = data.get('version') or datetime.now().strftime('%Y%m%d%H%M%S')

        os.makedirs(output_dir, exist_ok=True)

        # Export model artifact for edge runtime
        import joblib
        artifact_path = os.path.join(output_dir, f'edge_model_{version}.pkl')
        export_payload = {
            'version': version,
            'horizons': model.horizons,
            'sequence_length': model.sequence_length,
            'n_features': model.n_features,
            'features': model.feature_names,
            'metadata': model_metadata,
            'exported_at': datetime.now().isoformat()
        }
        joblib.dump(export_payload, artifact_path)

        logger.info(f"Exported edge model artifact to {artifact_path}")

        return jsonify({
            'status': 'success',
            'artifact_path': artifact_path,
            'version': version,
            'horizons': model.horizons,
            'n_features': model.n_features,
            'exported_at': export_payload['exported_at']
        })

    except Exception as e:
        logger.error(f"Error exporting edge model: {e}")
        return jsonify({'error': str(e)}), 500


@app.route('/federated/update', methods=['POST'])
def federated_update():
    """
    Accept a client weight update for federated learning

    Request body:
    {
        "client_id": "meter-123",
        "round_id": 1,
        "weights": {...},          // serialized model weights
        "num_samples": 100,        // optional sample count
        "metrics": {...}           // optional client metrics
    }

    Response:
    {
        "status": "accepted",
        "client_id": "meter-123",
        "round_id": 1,
        "updates_received": 3
    }
    """
    if federated_coordinator is None:
        return jsonify({'error': 'Federated coordinator not initialized'}), 503

    try:
        data = request.get_json()
        if not data:
            return jsonify({'error': 'Missing request body'}), 400

        client_id = data.get('client_id')
        weights = data.get('weights')

        if not client_id:
            return jsonify({'error': 'Missing client_id'}), 400
        if weights is None:
            return jsonify({'error': 'Missing weights'}), 400

        round_id = data.get('round_id')
        num_samples = data.get('num_samples', 1)
        client_metrics = data.get('metrics', {})

        accepted = federated_coordinator.receive_update(
            client_id=client_id,
            weights=weights,
            round_id=round_id,
            num_samples=num_samples,
            metrics=client_metrics
        )

        if not accepted:
            return jsonify({
                'error': 'Update rejected (stale round or invalid payload)'
            }), 400

        return jsonify({
            'status': 'accepted',
            'client_id': client_id,
            'round_id': federated_coordinator.current_round,
            'updates_received': federated_coordinator.num_pending_updates()
        })

    except Exception as e:
        logger.error(f"Error receiving federated update: {e}")
        return jsonify({'error': str(e)}), 500


@app.route('/federated/model', methods=['GET'])
def federated_model():
    """
    Return the current global federated model weights

    Response:
    {
        "round_id": 2,
        "version": "20240101000000",
        "weights": {...},
        "num_clients": 5,
        "updated_at": "2024-01-01T00:00:00"
    }
    """
    if federated_coordinator is None:
        return jsonify({'error': 'Federated coordinator not initialized'}), 503

    try:
        global_model = federated_coordinator.get_global_model()
        if global_model is None:
            return jsonify({'error': 'No global model available yet'}), 404

        return jsonify(global_model)

    except Exception as e:
        logger.error(f"Error fetching federated model: {e}")
        return jsonify({'error': str(e)}), 500


@app.route('/federated/aggregate', methods=['POST'])
def federated_aggregate():
    """
    Trigger a federated aggregation round

    Request body (optional):
    {
        "min_clients": 2,          // minimum updates required to aggregate
        "force": false             // aggregate even if below min_clients
    }

    Response:
    {
        "status": "success",
        "round_id": 2,
        "num_clients": 5,
        "aggregated_at": "2024-01-01T00:00:00"
    }
    """
    if federated_coordinator is None:
        return jsonify({'error': 'Federated coordinator not initialized'}), 503

    try:
        data = request.get_json(silent=True) or {}
        min_clients = data.get('min_clients', 2)
        force = data.get('force', False)

        result = federated_coordinator.train_federated_round(
            min_clients=min_clients,
            force=force
        )

        if not result.get('success'):
            return jsonify({
                'status': 'skipped',
                'reason': result.get('reason', 'aggregation not performed'),
                'updates_received': federated_coordinator.num_pending_updates()
            }), 409

        return jsonify({
            'status': 'success',
            'round_id': result['round_id'],
            'num_clients': result['num_clients'],
            'aggregated_at': result['aggregated_at']
        })

    except Exception as e:
        logger.error(f"Error aggregating federated round: {e}")
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
    
    # Initialize federated learning coordinator
    global federated_coordinator
    try:
        federated_coordinator = FederatedCoordinator()
        logger.info("Federated learning coordinator initialized")
    except Exception as e:
        logger.warning(f"Federated coordinator not initialized: {e}")
    
    # Load model
    if not load_model(args.model_dir):
        logger.error("Failed to load model. Exiting.")
        return
    
    # Start server
    logger.info(f"Starting prediction service on {args.host}:{args.port}")
    app.run(host=args.host, port=args.port, debug=False)


if __name__ == '__main__':
    main()
