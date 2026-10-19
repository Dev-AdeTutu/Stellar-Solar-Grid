"""
Data preprocessing pipeline with weather integration and feature engineering
"""

import pandas as pd
import numpy as np
from typing import Dict, List, Optional
from datetime import datetime, timedelta
import requests
from dotenv import load_dotenv
import os

load_dotenv()

class DataPreprocessor:
    """
    Preprocessor for load forecasting with weather integration
    """
    
    def __init__(self, weather_api_key: Optional[str] = None):
        """
        Initialize preprocessor
        
        Args:
            weather_api_key: API key for weather service (OpenWeatherMap)
        """
        self.weather_api_key = weather_api_key or os.getenv('WEATHER_API_KEY')
        self.weather_cache: Dict[str, pd.DataFrame] = {}
    
    def fetch_weather_data(
        self,
        lat: float,
        lon: float,
        start_date: datetime,
        end_date: datetime
    ) -> pd.DataFrame:
        """
        Fetch historical weather data
        
        Args:
            lat: Latitude
            lon: Longitude
            start_date: Start date
            end_date: End date
            
        Returns:
            DataFrame with weather data
        """
        cache_key = f"{lat}_{lon}_{start_date}_{end_date}"
        
        if cache_key in self.weather_cache:
            return self.weather_cache[cache_key]
        
        if not self.weather_api_key:
            print("Warning: No weather API key provided, using synthetic data")
            return self._generate_synthetic_weather(start_date, end_date)
        
        try:
            # Using OpenWeatherMap API for historical data
            url = "https://api.openweathermap.org/data/2.5/onecall/timemachine"
            
            weather_records = []
            current_date = start_date
            
            while current_date <= end_date:
                params = {
                    'lat': lat,
                    'lon': lon,
                    'dt': int(current_date.timestamp()),
                    'appid': self.weather_api_key,
                    'units': 'metric'
                }
                
                response = requests.get(url, params=params, timeout=10)
                response.raise_for_status()
                
                data = response.json()
                
                if 'hourly' in data:
                    for hour_data in data['hourly']:
                        weather_records.append({
                            'timestamp': datetime.fromtimestamp(hour_data['dt']),
                            'temperature': hour_data['temp'],
                            'humidity': hour_data['humidity'],
                            'wind_speed': hour_data['wind_speed'],
                            'clouds': hour_data['clouds'],
                            'pressure': hour_data['pressure']
                        })
                
                current_date += timedelta(days=1)
            
            df = pd.DataFrame(weather_records)
            self.weather_cache[cache_key] = df
            return df
            
        except Exception as e:
            print(f"Error fetching weather data: {e}")
            return self._generate_synthetic_weather(start_date, end_date)
    
    def _generate_synthetic_weather(
        self,
        start_date: datetime,
        end_date: datetime
    ) -> pd.DataFrame:
        """
        Generate synthetic weather data for testing
        
        Args:
            start_date: Start date
            end_date: End date
            
        Returns:
            DataFrame with synthetic weather data
        """
        timestamps = pd.date_range(start=start_date, end=end_date, freq='H')
        
        # Generate realistic patterns
        hours = timestamps.hour
        days = (timestamps - timestamps[0]).days
        
        # Temperature with daily and seasonal cycles
        temperature = (
            20 +  # Base temperature
            5 * np.sin(2 * np.pi * hours / 24) +  # Daily cycle
            10 * np.sin(2 * np.pi * days / 365) +  # Seasonal cycle
            np.random.normal(0, 2, len(timestamps))  # Noise
        )
        
        # Humidity (inverse correlation with temperature)
        humidity = (
            60 -
            0.5 * temperature +
            np.random.normal(0, 5, len(timestamps))
        ).clip(20, 100)
        
        # Wind speed
        wind_speed = np.abs(
            5 + np.random.normal(0, 2, len(timestamps))
        )
        
        # Cloud coverage
        clouds = np.random.uniform(0, 100, len(timestamps))
        
        # Atmospheric pressure
        pressure = 1013 + np.random.normal(0, 10, len(timestamps))
        
        return pd.DataFrame({
            'timestamp': timestamps,
            'temperature': temperature,
            'humidity': humidity,
            'wind_speed': wind_speed,
            'clouds': clouds,
            'pressure': pressure
        })
    
    def engineer_features(self, df: pd.DataFrame) -> pd.DataFrame:
        """
        Engineer time-based and derived features
        
        Args:
            df: Input dataframe with timestamp column
            
        Returns:
            DataFrame with engineered features
        """
        df = df.copy()
        
        # Ensure timestamp is datetime
        if 'timestamp' in df.columns:
            df['timestamp'] = pd.to_datetime(df['timestamp'])
            df = df.set_index('timestamp')
        
        # Time-based features
        df['hour'] = df.index.hour
        df['day_of_week'] = df.index.dayofweek
        df['day_of_month'] = df.index.day
        df['month'] = df.index.month
        df['quarter'] = df.index.quarter
        df['year'] = df.index.year
        
        # Cyclical encoding for hour and day of week
        df['hour_sin'] = np.sin(2 * np.pi * df['hour'] / 24)
        df['hour_cos'] = np.cos(2 * np.pi * df['hour'] / 24)
        df['dow_sin'] = np.sin(2 * np.pi * df['day_of_week'] / 7)
        df['dow_cos'] = np.cos(2 * np.pi * df['day_of_week'] / 7)
        
        # Is weekend
        df['is_weekend'] = (df['day_of_week'] >= 5).astype(int)
        
        # Is business hour (9am - 5pm on weekdays)
        df['is_business_hour'] = (
            (df['hour'] >= 9) & 
            (df['hour'] < 17) & 
            (df['day_of_week'] < 5)
        ).astype(int)
        
        # Season encoding
        df['is_winter'] = df['month'].isin([12, 1, 2]).astype(int)
        df['is_spring'] = df['month'].isin([3, 4, 5]).astype(int)
        df['is_summer'] = df['month'].isin([6, 7, 8]).astype(int)
        df['is_autumn'] = df['month'].isin([9, 10, 11]).astype(int)
        
        return df
    
    def add_lag_features(
        self,
        df: pd.DataFrame,
        target_column: str = 'load',
        lags: List[int] = [1, 2, 3, 24, 48, 168]
    ) -> pd.DataFrame:
        """
        Add lag features for time series
        
        Args:
            df: Input dataframe
            target_column: Target column name
            lags: List of lag periods
            
        Returns:
            DataFrame with lag features
        """
        df = df.copy()
        
        for lag in lags:
            df[f'{target_column}_lag_{lag}'] = df[target_column].shift(lag)
        
        return df
    
    def add_rolling_features(
        self,
        df: pd.DataFrame,
        target_column: str = 'load',
        windows: List[int] = [3, 6, 12, 24, 168]
    ) -> pd.DataFrame:
        """
        Add rolling statistics features
        
        Args:
            df: Input dataframe
            target_column: Target column name
            windows: List of window sizes
            
        Returns:
            DataFrame with rolling features
        """
        df = df.copy()
        
        for window in windows:
            # Rolling mean
            df[f'{target_column}_rolling_mean_{window}'] = (
                df[target_column].rolling(window=window).mean()
            )
            
            # Rolling std
            df[f'{target_column}_rolling_std_{window}'] = (
                df[target_column].rolling(window=window).std()
            )
            
            # Rolling min/max
            df[f'{target_column}_rolling_min_{window}'] = (
                df[target_column].rolling(window=window).min()
            )
            df[f'{target_column}_rolling_max_{window}'] = (
                df[target_column].rolling(window=window).max()
            )
        
        return df
    
    def add_weather_features(
        self,
        df: pd.DataFrame,
        weather_df: pd.DataFrame
    ) -> pd.DataFrame:
        """
        Merge weather features with load data
        
        Args:
            df: Load dataframe
            weather_df: Weather dataframe
            
        Returns:
            Merged dataframe
        """
        # Ensure both have timestamp index
        if 'timestamp' in df.columns:
            df = df.set_index('timestamp')
        if 'timestamp' in weather_df.columns:
            weather_df = weather_df.set_index('timestamp')
        
        # Merge on timestamp
        df = df.join(weather_df, how='left')
        
        # Forward fill missing weather values
        df = df.fillna(method='ffill')
        
        # Derived weather features
        if 'temperature' in df.columns and 'humidity' in df.columns:
            # Heat index approximation
            df['heat_index'] = (
                df['temperature'] + 
                0.5555 * (6.11 * np.exp(5417.7530 * 
                         (1/273.16 - 1/(273.15 + df['temperature']))) - 10)
            )
            
            # Temperature-humidity interaction
            df['temp_humidity_interaction'] = (
                df['temperature'] * df['humidity'] / 100
            )
        
        return df
    
    def prepare_training_data(
        self,
        load_df: pd.DataFrame,
        weather_df: Optional[pd.DataFrame] = None,
        target_column: str = 'load'
    ) -> pd.DataFrame:
        """
        Complete preprocessing pipeline
        
        Args:
            load_df: Load data
            weather_df: Weather data (optional)
            target_column: Target column name
            
        Returns:
            Preprocessed dataframe ready for training
        """
        print("Starting preprocessing pipeline...")
        
        # Engineer time features
        df = self.engineer_features(load_df)
        
        # Add weather features if available
        if weather_df is not None:
            df = self.add_weather_features(df, weather_df)
        
        # Add lag features
        df = self.add_lag_features(df, target_column)
        
        # Add rolling features
        df = self.add_rolling_features(df, target_column)
        
        # Drop rows with NaN (from lag and rolling operations)
        initial_rows = len(df)
        df = df.dropna()
        dropped_rows = initial_rows - len(df)
        
        print(f"Preprocessing complete. Dropped {dropped_rows} rows with missing values.")
        print(f"Final dataset shape: {df.shape}")
        
        return df
    
    def generate_synthetic_load_data(
        self,
        start_date: datetime,
        end_date: datetime,
        base_load: float = 1000.0
    ) -> pd.DataFrame:
        """
        Generate synthetic load data for testing
        
        Args:
            start_date: Start date
            end_date: End date
            base_load: Base load in kW
            
        Returns:
            DataFrame with synthetic load data
        """
        timestamps = pd.date_range(start=start_date, end=end_date, freq='H')
        
        hours = timestamps.hour
        days_of_week = timestamps.dayofweek
        days = (timestamps - timestamps[0]).days
        
        # Base pattern with daily cycle
        daily_pattern = base_load * (
            0.6 +  # Minimum load factor
            0.4 * (1 + np.sin(2 * np.pi * (hours - 6) / 24)) / 2  # Peak at 6pm
        )
        
        # Weekend reduction
        weekend_factor = np.where(days_of_week >= 5, 0.8, 1.0)
        
        # Seasonal variation
        seasonal_factor = 1 + 0.2 * np.sin(2 * np.pi * days / 365)
        
        # Random noise
        noise = np.random.normal(1.0, 0.05, len(timestamps))
        
        # Combine all factors
        load = daily_pattern * weekend_factor * seasonal_factor * noise
        
        return pd.DataFrame({
            'timestamp': timestamps,
            'load': load
        })
