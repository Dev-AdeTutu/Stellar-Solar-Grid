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
import json
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

    def export_edge_model(
        self,
        edge_dir: str,
        quantize: bool = True,
        reduced_units: Optional[int] = 32,
        representative_data: Optional[np.ndarray] = None
    ) -> Dict:
        """
        Export a lightweight, edge-deployable version of the trained models.

        The exported artifacts are intended to be loaded by the backend edge
        runtime on meter devices for local inference without cloud connectivity.
        This produces:
          - Reduced-size LSTM models per horizon (fewer units) when
            ``reduced_units`` is provided.
          - Optional post-training quantization (float16 / int8 dynamic range)
            to shrink model size and reduce inference latency.
          - Scalers and metadata serialized as JSON-friendly artifacts so the
            edge runtime can pre/post-process inputs and outputs.

        Args:
            edge_dir: Directory to write edge artifacts into.
            quantize: Whether to apply post-training quantization.
            reduced_units: Target number of units for the reduced LSTM layers.
                If None, the original model architectures are exported as-is.
            representative_data: Optional representative input array of shape
                (n_samples, sequence_length, n_features) used for full
                integer quantization calibration. If omitted, dynamic-range
                quantization is used instead.

        Returns:
            Dictionary describing the exported artifacts and their sizes.
        """
        if not self.models:
            raise ValueError("No trained models available to export")

        os.makedirs(edge_dir, exist_ok=True)

        export_info: Dict = {
            'edge_dir': edge_dir,
            'quantized': bool(quantize),
            'reduced_units': reduced_units,
            'horizons': {},
            'timestamp': datetime.now().isoformat(),
        }

        for horizon, model in self.models.items():
            # Build a lightweight reduced model when requested.
            if reduced_units is not None:
                edge_model = self._build_reduced_model(horizon, reduced_units)
                # Transfer weights from the full model where shapes match.
                self._transfer_weights(model, edge_model)
            else:
                edge_model = model

            model_path = os.path.join(edge_dir, f'edge_model_{horizon}h.keras')
            edge_model.save(model_path)

            size_bytes = os.path.getsize(model_path)

            # Apply post-training quantization for a smaller footprint.
            if quantize:
                quantized_path = os.path.join(
                    edge_dir, f'edge_model_{horizon}h_quantized.tflite'
                )
                try:
                    self._quantize_model(
                        edge_model,
                        quantized_path,
                        representative_data=representative_data,
                    )
                    size_bytes = os.path.getsize(quantized_path)
                    model_path = quantized_path
                except Exception as exc:  # pragma: no cover - defensive
                    print(
                        f"Quantization failed for horizon {horizon}h: {exc}. "
                        "Falling back to unquantized edge model."
                    )

            export_info['horizons'][horizon] = {
                'model_path': model_path,
                'size_bytes': size_bytes,
            }

        # Persist scalers in a portable JSON format for the edge runtime.
        scaler_meta = {
            'scaler_X': {
                'mean': self.scaler_X.mean_.tolist()
                if hasattr(self.scaler_X, 'mean_') else None,
                'scale': self.scaler_X.scale_.tolist()
                if hasattr(self.scaler_X, 'scale_') else None,
                'var': self.scaler_X.var_.tolist()
                if hasattr(self.scaler_X, 'var_') else None,
            },
            'scaler_y': {
                'data_min': self.scaler_y.data_min_.tolist()
                if hasattr(self.scaler_y, 'data_min_') else None,
                'data_max': self.scaler_y.data_max_.tolist()
                if hasattr(self.scaler_y, 'data_max_') else None,
                'scale': self.scaler_y.scale_.tolist()
                if hasattr(self.scaler_y, 'scale_') else None,
                'min': self.scaler_y.min_.tolist()
                if hasattr(self.scaler_y, 'min_') else None,
            },
        }
        with open(os.path.join(edge_dir, 'scalers.json'), 'w') as f:
            json.dump(scaler_meta, f)

        # Also keep pickled scalers for convenience / backward compatibility.
        joblib.dump(self.scaler_X, os.path.join(edge_dir, 'scaler_X.pkl'))
        joblib.dump(self.scaler_y, os.path.join(edge_dir, 'scaler_y.pkl'))

        metadata = {
            'sequence_length': self.sequence_length,
            'n_features': self.n_features,
            'horizons': self.horizons,
            'feature_names': self.feature_names,
            'quantized': bool(quantize),
            'reduced_units': reduced_units,
            'timestamp': datetime.now().isoformat(),
        }
        with open(os.path.join(edge_dir, 'metadata.json'), 'w') as f:
            json.dump(metadata, f, indent=2)
        joblib.dump(metadata, os.path.join(edge_dir, 'metadata.pkl'))

        export_info['metadata_path'] = os.path.join(edge_dir, 'metadata.json')
        export_info['scalers_path'] = os.path.join(edge_dir, 'scalers.json')

        print(f"Edge models exported to {edge_dir}")
        return export_info

    def _build_reduced_model(self, horizon: int, units: int) -> keras.Model:
        """
        Build a reduced-size LSTM model suitable for edge deployment.

        Args:
            horizon: Prediction horizon in hours.
            units: Base number of units for the first LSTM layer.

        Returns:
            Compiled lightweight Keras model.
        """
        model = keras.Sequential([
            layers.LSTM(
                units,
                return_sequences=True,
                input_shape=(self.sequence_length, self.n_features),
            ),
            layers.LSTM(max(units // 2, 8), return_sequences=False),
            layers.Dense(max(units // 2, 8), activation='relu'),
            layers.Dense(horizon),
        ])
        model.compile(optimizer='adam', loss='mse', metrics=['mae'])
        return model

    @staticmethod
    def _transfer_weights(source: keras.Model, target: keras.Model):
        """
        Best-effort transfer of weights from a full model to a reduced model.

        Only layers with matching weight shapes are copied; mismatched layers
        keep their freshly initialized weights.

        Args:
            source: Full-size trained model.
            target: Reduced-size target model.
        """
        source_layers = source.layers
        target_layers = target.layers
        for src_layer, tgt_layer in zip(source_layers, target_layers):
            try:
                src_weights = src_layer.get_weights()
                tgt_weights = tgt_layer.get_weights()
                if not src_weights or not tgt_weights:
                    continue
                if all(
                    sw.shape == tw.shape
                    for sw, tw in zip(src_weights, tgt_weights)
                ):
                    tgt_layer.set_weights(src_weights)
            except Exception:  # pragma: no cover - defensive
                continue

    @staticmethod
    def _quantize_model(
        model: keras.Model,
        output_path: str,
        representative_data: Optional[np.ndarray] = None,
    ):
        """
        Convert a Keras model to a quantized TFLite model for edge inference.

        Args:
            model: Keras model to convert.
            output_path: Destination path for the .tflite file.
            representative_data: Optional calibration data for full integer
                quantization. When omitted, dynamic-range quantization is used.
        """
        converter = tf.lite.TFLiteConverter.from_keras_model(model)

        if representative_data is not None:
            def _representative_dataset():
                for sample in representative_data:
                    yield [sample.reshape(1, *sample.shape).astype(np.float32)]

            converter.optimizations = [tf.lite.Optimize.DEFAULT]
            converter.representative_dataset = _representative_dataset
            converter.target_spec.supported_ops = [
                tf.lite.OpsSet.TFLITE_BUILTINS_INT8
            ]
            converter.inference_input_type = tf.float32
            converter.inference_output_type = tf.float32
        else:
            converter.optimizations = [tf.lite.Optimize.DEFAULT]

        tflite_model = converter.convert()
        with open(output_path, 'wb') as f:
            f.write(tflite_model)