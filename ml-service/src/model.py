"""
Load Forecasting ML Model using LSTM/GRU
Multi-horizon predictions: 1h, 24h, 168h (7 days)
"""

import numpy as np
import pandas as pd
from typing import Dict, List, Tuple, Optional
import tensorflow as tf
from tensorflow import keras
from keras import layers
from sklearn.preprocessing import StandardScaler, MinMaxScaler
from sklearn.model_selection import train_test_split
import joblib
import os
from datetime import datetime, timedelta

class LoadForecastingModel:
    """
    LSTM-based load forecasting model with weather integration
    """
    
    def __init__(
        self,
        sequence_length: int = 168,  # 7 days of hourly data
        n_features: int = 10,
        horizons: List[int] = [1, 24, 168]
    ):
        """
        Initialize the load forecasting model
        
        Args:
            sequence_length: Number of time steps to look back
            n_features: Number of input features
            horizons: Prediction horizons in hours
        """
        self.sequence_length = sequence_length
        self.n_features = n_features
        self.horizons = horizons
        self.models: Dict[int, keras.Model] = {}
        self.scaler_X = StandardScaler()
        self.scaler_y = MinMaxScaler()
        self.feature_names = []
        
    def build_model(self, horizon: int) -> keras.Model:
        """
        Build LSTM model for specific forecast horizon
        
        Args:
            horizon: Prediction horizon in hours
            
        Returns:
            Compiled Keras model
        """
        model = keras.Sequential([
            # First LSTM layer with return sequences
            layers.LSTM(
                128,
                return_sequences=True,
                input_shape=(self.sequence_length, self.n_features),
                dropout=0.2
            ),
            layers.BatchNormalization(),
            
            # Second LSTM layer
            layers.LSTM(64, return_sequences=True, dropout=0.2),
            layers.BatchNormalization(),
            
            # Third LSTM layer
            layers.LSTM(32, return_sequences=False, dropout=0.2),
            layers.BatchNormalization(),
            
            # Dense layers
            layers.Dense(64, activation='relu'),
            layers.Dropout(0.3),
            layers.Dense(32, activation='relu'),
            layers.Dropout(0.2),
            
            # Output layer
            layers.Dense(horizon)
        ])
        
        # Use custom learning rate schedule
        lr_schedule = keras.optimizers.schedules.ExponentialDecay(
            initial_learning_rate=0.001,
            decay_steps=1000,
            decay_rate=0.9
        )
        
        optimizer = keras.optimizers.Adam(learning_rate=lr_schedule)
        
        model.compile(
            optimizer=optimizer,
            loss='mse',
            metrics=['mae', 'mape']
        )
        
        return model
    
    def prepare_sequences(
        self,
        data: np.ndarray,
        targets: np.ndarray,
        horizon: int
    ) -> Tuple[np.ndarray, np.ndarray]:
        """
        Prepare sequences for training
        
        Args:
            data: Input features
            targets: Target values
            horizon: Prediction horizon
            
        Returns:
            X, y arrays for training
        """
        X, y = [], []
        
        for i in range(len(data) - self.sequence_length - horizon):
            X.append(data[i:i + self.sequence_length])
            y.append(targets[i + self.sequence_length:i + self.sequence_length + horizon])
        
        return np.array(X), np.array(y)
    
    def train(
        self,
        df: pd.DataFrame,
        target_column: str = 'load',
        epochs: int = 100,
        batch_size: int = 32,
        validation_split: float = 0.2
    ) -> Dict[int, Dict]:
        """
        Train models for all horizons
        
        Args:
            df: Training dataframe with features and target
            target_column: Name of target column
            epochs: Number of training epochs
            batch_size: Batch size for training
            validation_split: Validation split ratio
            
        Returns:
            Training history for each horizon
        """
        # Store feature names
        self.feature_names = [col for col in df.columns if col != target_column]
        
        # Prepare data
        X = df[self.feature_names].values
        y = df[target_column].values
        
        # Scale features
        X_scaled = self.scaler_X.fit_transform(X)
        y_scaled = self.scaler_y.fit_transform(y.reshape(-1, 1)).flatten()
        
        histories = {}
        
        for horizon in self.horizons:
            print(f"\nTraining model for {horizon}h horizon...")
            
            # Prepare sequences
            X_seq, y_seq = self.prepare_sequences(X_scaled, y_scaled, horizon)
            
            # Split data
            X_train, X_val, y_train, y_val = train_test_split(
                X_seq, y_seq, test_size=validation_split, shuffle=False
            )
            
            # Build model
            model = self.build_model(horizon)
            
            # Callbacks
            early_stopping = keras.callbacks.EarlyStopping(
                monitor='val_loss',
                patience=10,
                restore_best_weights=True
            )
            
            reduce_lr = keras.callbacks.ReduceLROnPlateau(
                monitor='val_loss',
                factor=0.5,
                patience=5,
                min_lr=1e-7
            )
            
            # Train
            history = model.fit(
                X_train, y_train,
                epochs=epochs,
                batch_size=batch_size,
                validation_data=(X_val, y_val),
                callbacks=[early_stopping, reduce_lr],
                verbose=1
            )
            
            self.models[horizon] = model
            histories[horizon] = history.history
            
            # Evaluate
            val_loss, val_mae, val_mape = model.evaluate(X_val, y_val, verbose=0)
            accuracy = 100 - val_mape
            
            print(f"Horizon {horizon}h - Validation Accuracy: {accuracy:.2f}%")
            print(f"Horizon {horizon}h - Validation MAE: {val_mae:.4f}")
        
        return histories
    
    def predict(
        self,
        recent_data: pd.DataFrame,
        horizon: int
    ) -> np.ndarray:
        """
        Make predictions for specified horizon
        
        Args:
            recent_data: Recent data for prediction (should have sequence_length rows)
            horizon: Prediction horizon in hours
            
        Returns:
            Predicted load values (unscaled)
        """
        if horizon not in self.models:
            raise ValueError(f"No model trained for horizon {horizon}h")
        
        if len(recent_data) < self.sequence_length:
            raise ValueError(
                f"Need at least {self.sequence_length} rows of recent data"
            )
        
        # Get last sequence_length rows
        X = recent_data[self.feature_names].tail(self.sequence_length).values
        
        # Scale
        X_scaled = self.scaler_X.transform(X)
        X_seq = X_scaled.reshape(1, self.sequence_length, self.n_features)
        
        # Predict
        model = self.models[horizon]
        y_pred_scaled = model.predict(X_seq, verbose=0)
        
        # Unscale
        y_pred = self.scaler_y.inverse_transform(
            y_pred_scaled.reshape(-1, 1)
        ).flatten()
        
        return y_pred
    
    def predict_all_horizons(
        self,
        recent_data: pd.DataFrame
    ) -> Dict[int, np.ndarray]:
        """
        Make predictions for all horizons
        
        Args:
            recent_data: Recent data for prediction
            
        Returns:
            Dictionary mapping horizon to predictions
        """
        predictions = {}
        
        for horizon in self.horizons:
            predictions[horizon] = self.predict(recent_data, horizon)
        
        return predictions
    
    def evaluate(
        self,
        test_data: pd.DataFrame,
        target_column: str = 'load'
    ) -> Dict[int, Dict[str, float]]:
        """
        Evaluate model on test data
        
        Args:
            test_data: Test dataframe
            target_column: Name of target column
            
        Returns:
            Evaluation metrics for each horizon
        """
        X = test_data[self.feature_names].values
        y = test_data[target_column].values
        
        X_scaled = self.scaler_X.transform(X)
        y_scaled = self.scaler_y.transform(y.reshape(-1, 1)).flatten()
        
        results = {}
        
        for horizon in self.horizons:
            X_seq, y_seq = self.prepare_sequences(X_scaled, y_scaled, horizon)
            
            model = self.models[horizon]
            loss, mae, mape = model.evaluate(X_seq, y_seq, verbose=0)
            
            accuracy = 100 - mape
            
            results[horizon] = {
                'loss': float(loss),
                'mae': float(mae),
                'mape': float(mape),
                'accuracy': float(accuracy)
            }
        
        return results
    
    def save(self, model_dir: str):
        """
        Save models and scalers
        
        Args:
            model_dir: Directory to save models
        """
        os.makedirs(model_dir, exist_ok=True)
        
        # Save models
        for horizon, model in self.models.items():
            model_path = os.path.join(model_dir, f'model_{horizon}h.keras')
            model.save(model_path)
        
        # Save scalers and metadata
        joblib.dump(self.scaler_X, os.path.join(model_dir, 'scaler_X.pkl'))
        joblib.dump(self.scaler_y, os.path.join(model_dir, 'scaler_y.pkl'))
        
        metadata = {
            'sequence_length': self.sequence_length,
            'n_features': self.n_features,
            'horizons': self.horizons,
            'feature_names': self.feature_names,
            'timestamp': datetime.now().isoformat()
        }
        joblib.dump(metadata, os.path.join(model_dir, 'metadata.pkl'))
        
        print(f"Models saved to {model_dir}")
    
    def load(self, model_dir: str):
        """
        Load models and scalers
        
        Args:
            model_dir: Directory containing saved models
        """
        # Load metadata
        metadata = joblib.load(os.path.join(model_dir, 'metadata.pkl'))
        self.sequence_length = metadata['sequence_length']
        self.n_features = metadata['n_features']
        self.horizons = metadata['horizons']
        self.feature_names = metadata['feature_names']
        
        # Load scalers
        self.scaler_X = joblib.load(os.path.join(model_dir, 'scaler_X.pkl'))
        self.scaler_y = joblib.load(os.path.join(model_dir, 'scaler_y.pkl'))
        
        # Load models
        self.models = {}
        for horizon in self.horizons:
            model_path = os.path.join(model_dir, f'model_{horizon}h.keras')
            self.models[horizon] = keras.models.load_model(model_path)
        
        print(f"Models loaded from {model_dir}")
