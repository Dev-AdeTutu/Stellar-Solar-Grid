"""
Training script for load forecasting model
Includes model evaluation and validation to ensure >90% accuracy
"""

import argparse
import os
import sys
from datetime import datetime, timedelta
import pandas as pd
import numpy as np
import json
from typing import Dict, Optional

from model import LoadForecastingModel
from preprocessing import DataPreprocessor


def load_data_from_db(db_path: Optional[str] = None) -> pd.DataFrame:
    """
    Load historical load data from database
    
    Args:
        db_path: Path to SQLite database
        
    Returns:
        DataFrame with load data
    """
    if db_path and os.path.exists(db_path):
        import sqlite3
        conn = sqlite3.connect(db_path)
        
        query = """
        SELECT timestamp, total_load as load
        FROM energy_metrics
        ORDER BY timestamp
        """
        
        df = pd.read_sql_query(query, conn)
        conn.close()
        
        df['timestamp'] = pd.to_datetime(df['timestamp'])
        return df
    else:
        print("No database found, generating synthetic data for training...")
        preprocessor = DataPreprocessor()
        
        # Generate 2 years of synthetic data
        end_date = datetime.now()
        start_date = end_date - timedelta(days=730)
        
        return preprocessor.generate_synthetic_load_data(
            start_date=start_date,
            end_date=end_date,
            base_load=1000.0
        )


def train_model(
    data_path: Optional[str] = None,
    model_dir: str = './models/latest',
    epochs: int = 100,
    batch_size: int = 32,
    validation_split: float = 0.2,
    test_split: float = 0.1,
    weather_api_key: Optional[str] = None,
    lat: float = 37.7749,
    lon: float = -122.4194
) -> Dict:
    """
    Train load forecasting model
    
    Args:
        data_path: Path to historical data (CSV or database)
        model_dir: Directory to save trained models
        epochs: Number of training epochs
        batch_size: Batch size
        validation_split: Validation split ratio
        test_split: Test split ratio
        weather_api_key: Weather API key
        lat: Latitude for weather data
        lon: Longitude for weather data
        
    Returns:
        Training results and metrics
    """
    print("=" * 80)
    print("LOAD FORECASTING MODEL TRAINING")
    print("=" * 80)
    print(f"Start time: {datetime.now().isoformat()}")
    print()
    
    # Load historical load data
    print("Loading historical load data...")
    if data_path and data_path.endswith('.csv'):
        load_df = pd.read_csv(data_path)
    else:
        load_df = load_data_from_db(data_path)
    
    print(f"Loaded {len(load_df)} records")
    print(f"Date range: {load_df['timestamp'].min()} to {load_df['timestamp'].max()}")
    print()
    
    # Initialize preprocessor
    preprocessor = DataPreprocessor(weather_api_key=weather_api_key)
    
    # Fetch weather data
    print("Fetching weather data...")
    start_date = pd.to_datetime(load_df['timestamp'].min())
    end_date = pd.to_datetime(load_df['timestamp'].max())
    
    weather_df = preprocessor.fetch_weather_data(
        lat=lat,
        lon=lon,
        start_date=start_date,
        end_date=end_date
    )
    print(f"Weather data shape: {weather_df.shape}")
    print()
    
    # Preprocess data
    print("Preprocessing data...")
    df = preprocessor.prepare_training_data(
        load_df=load_df,
        weather_df=weather_df,
        target_column='load'
    )
    print()
    
    # Split data
    print("Splitting data into train/validation/test sets...")
    n_test = int(len(df) * test_split)
    n_val = int(len(df) * validation_split)
    n_train = len(df) - n_test - n_val
    
    train_df = df.iloc[:n_train]
    val_df = df.iloc[n_train:n_train + n_val]
    test_df = df.iloc[n_train + n_val:]
    
    print(f"Train: {len(train_df)} samples")
    print(f"Validation: {len(val_df)} samples")
    print(f"Test: {len(test_df)} samples")
    print()
    
    # Combine train and validation for training (model internally splits for validation)
    train_val_df = pd.concat([train_df, val_df])
    
    # Initialize model
    print("Initializing model...")
    feature_columns = [col for col in df.columns if col != 'load']
    n_features = len(feature_columns)
    
    model = LoadForecastingModel(
        sequence_length=168,  # 7 days
        n_features=n_features,
        horizons=[1, 24, 168]
    )
    print(f"Model initialized with {n_features} features")
    print(f"Feature names: {feature_columns[:10]}... (showing first 10)")
    print()
    
    # Train model
    print("Training models for all horizons...")
    print("-" * 80)
    histories = model.train(
        df=train_val_df,
        target_column='load',
        epochs=epochs,
        batch_size=batch_size,
        validation_split=validation_split
    )
    print("-" * 80)
    print()
    
    # Evaluate on test set
    print("Evaluating on test set...")
    test_results = model.evaluate(test_df, target_column='load')
    
    print("\nTest Set Results:")
    print("-" * 80)
    for horizon, metrics in test_results.items():
        print(f"\nHorizon: {horizon}h")
        print(f"  Accuracy: {metrics['accuracy']:.2f}%")
        print(f"  MAE: {metrics['mae']:.4f}")
        print(f"  MAPE: {metrics['mape']:.2f}%")
        print(f"  Loss: {metrics['loss']:.4f}")
        
        # Check if meets requirement
        if metrics['accuracy'] >= 90.0:
            print(f"  ✓ Meets >90% accuracy requirement")
        else:
            print(f"  ✗ Below 90% accuracy requirement")
    print("-" * 80)
    print()
    
    # Save model
    print(f"Saving model to {model_dir}...")
    model.save(model_dir)
    
    # Save test results
    results_path = os.path.join(model_dir, 'test_results.json')
    with open(results_path, 'w') as f:
        json.dump(test_results, f, indent=2)
    print(f"Test results saved to {results_path}")
    
    # Save training history
    history_path = os.path.join(model_dir, 'training_history.json')
    
    # Convert numpy types to native Python types for JSON serialization
    serializable_histories = {}
    for horizon, history in histories.items():
        serializable_histories[str(horizon)] = {
            key: [float(v) for v in values]
            for key, values in history.items()
        }
    
    with open(history_path, 'w') as f:
        json.dump(serializable_histories, f, indent=2)
    print(f"Training history saved to {history_path}")
    print()
    
    # Generate summary
    summary = {
        'training_date': datetime.now().isoformat(),
        'data_records': len(load_df),
        'features': n_features,
        'train_samples': len(train_df),
        'validation_samples': len(val_df),
        'test_samples': len(test_df),
        'epochs': epochs,
        'batch_size': batch_size,
        'test_results': test_results,
        'all_horizons_pass': all(
            metrics['accuracy'] >= 90.0 
            for metrics in test_results.values()
        )
    }
    
    summary_path = os.path.join(model_dir, 'training_summary.json')
    with open(summary_path, 'w') as f:
        json.dump(summary, f, indent=2)
    print(f"Training summary saved to {summary_path}")
    
    print()
    print("=" * 80)
    print("TRAINING COMPLETE")
    print("=" * 80)
    print(f"End time: {datetime.now().isoformat()}")
    
    if summary['all_horizons_pass']:
        print("\n✓ All horizons meet >90% accuracy requirement!")
    else:
        print("\n✗ Some horizons below 90% accuracy - consider retraining")
    
    return summary


def main():
    """Main training function"""
    parser = argparse.ArgumentParser(
        description='Train load forecasting model'
    )
    
    parser.add_argument(
        '--data-path',
        type=str,
        default=None,
        help='Path to historical data (CSV or SQLite database)'
    )
    
    parser.add_argument(
        '--model-dir',
        type=str,
        default='./models/latest',
        help='Directory to save trained models'
    )
    
    parser.add_argument(
        '--epochs',
        type=int,
        default=100,
        help='Number of training epochs'
    )
    
    parser.add_argument(
        '--batch-size',
        type=int,
        default=32,
        help='Batch size'
    )
    
    parser.add_argument(
        '--validation-split',
        type=float,
        default=0.2,
        help='Validation split ratio'
    )
    
    parser.add_argument(
        '--test-split',
        type=float,
        default=0.1,
        help='Test split ratio'
    )
    
    parser.add_argument(
        '--weather-api-key',
        type=str,
        default=None,
        help='Weather API key (OpenWeatherMap)'
    )
    
    parser.add_argument(
        '--lat',
        type=float,
        default=37.7749,
        help='Latitude for weather data'
    )
    
    parser.add_argument(
        '--lon',
        type=float,
        default=-122.4194,
        help='Longitude for weather data'
    )
    
    args = parser.parse_args()
    
    try:
        summary = train_model(
            data_path=args.data_path,
            model_dir=args.model_dir,
            epochs=args.epochs,
            batch_size=args.batch_size,
            validation_split=args.validation_split,
            test_split=args.test_split,
            weather_api_key=args.weather_api_key,
            lat=args.lat,
            lon=args.lon
        )
        
        # Exit with error if accuracy requirement not met
        if not summary['all_horizons_pass']:
            sys.exit(1)
            
    except Exception as e:
        print(f"\nError during training: {e}", file=sys.stderr)
        import traceback
        traceback.print_exc()
        sys.exit(1)


if __name__ == '__main__':
    main()
