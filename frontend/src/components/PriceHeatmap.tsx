/**
 * Interactive Energy Price Heatmap Component
 * Real-time visualization with historical playback
 */

import React, { useState, useEffect, useCallback, useMemo } from 'react';
import dynamic from 'next/dynamic';
import { MapContainer, TileLayer, CircleMarker, Popup, useMap } from 'react-leaflet';
import { LatLngExpression } from 'leaflet';
import 'leaflet/dist/leaflet.css';

// Dynamic import to avoid SSR issues with Leaflet
const MapWrapper = dynamic(() => Promise.resolve(MapContainer), { ssr: false });

interface GridZone {
  id: string;
  lat: number;
  lon: number;
  price: number;
  name: string;
  region: string;
}

interface HeatmapData {
  zones: GridZone[];
  priceRange: { min: number; max: number };
  timestamp: Date;
}

interface PriceSnapshot {
  timestamp: string;
  prices: Record<string, number>;
}

interface PriceHeatmapProps {
  autoUpdate?: boolean;
  updateInterval?: number;
}

/**
 * Get color for price based on range
 */
function getPriceColor(price: number, min: number, max: number): string {
  const range = max - min;
  const normalized = range > 0 ? (price - min) / range : 0.5;
  
  // Color gradient: Green (low) -> Yellow (medium) -> Red (high)
  if (normalized < 0.33) {
    // Green to Yellow
    const t = normalized / 0.33;
    return `rgb(${Math.round(0 + 255 * t)}, ${Math.round(200 - 45 * t)}, 0)`;
  } else if (normalized < 0.67) {
    // Yellow to Orange
    const t = (normalized - 0.33) / 0.34;
    return `rgb(255, ${Math.round(155 - 80 * t)}, 0)`;
  } else {
    // Orange to Red
    const t = (normalized - 0.67) / 0.33;
    return `rgb(255, ${Math.round(75 - 75 * t)}, 0)`;
  }
}

/**
 * Legend component
 */
const PriceLegend: React.FC<{ min: number; max: number }> = ({ min, max }) => {
  const steps = 10;
  const gradientStops = Array.from({ length: steps }, (_, i) => {
    const value = min + (max - min) * (i / (steps - 1));
    const color = getPriceColor(value, min, max);
    return { value, color, percent: (i / (steps - 1)) * 100 };
  });

  return (
    <div className="absolute bottom-8 left-8 bg-white p-4 rounded-lg shadow-lg z-[1000]">
      <h3 className="text-sm font-semibold mb-2">Price ($/kWh)</h3>
      <div className="flex items-center gap-2">
        <span className="text-xs">${min.toFixed(3)}</span>
        <div 
          className="w-48 h-6 rounded"
          style={{
            background: `linear-gradient(to right, ${gradientStops.map(s => `${s.color} ${s.percent}%`).join(', ')})`
          }}
        />
        <span className="text-xs">${max.toFixed(3)}</span>
      </div>
    </div>
  );
};

/**
 * Timeline control component
 */
const TimelineControl: React.FC<{
  snapshots: PriceSnapshot[];
  currentIndex: number;
  onIndexChange: (index: number) => void;
  isPlaying: boolean;
  onPlayPause: () => void;
}> = ({ snapshots, currentIndex, onIndexChange, isPlaying, onPlayPause }) => {
  if (snapshots.length === 0) return null;

  const currentSnapshot = snapshots[currentIndex];

  return (
    <div className="absolute bottom-8 right-8 bg-white p-4 rounded-lg shadow-lg z-[1000] w-96">
      <div className="flex items-center justify-between mb-2">
        <h3 className="text-sm font-semibold">Historical Playback</h3>
        <span className="text-xs text-gray-600">
          {new Date(currentSnapshot.timestamp).toLocaleString()}
        </span>
      </div>
      
      <div className="flex items-center gap-2 mb-2">
        <button
          onClick={onPlayPause}
          className="px-3 py-1 bg-blue-500 text-white rounded hover:bg-blue-600 text-sm"
        >
          {isPlaying ? '⏸ Pause' : '▶ Play'}
        </button>
        
        <button
          onClick={() => onIndexChange(0)}
          disabled={currentIndex === 0}
          className="px-2 py-1 bg-gray-200 rounded hover:bg-gray-300 disabled:opacity-50 text-sm"
        >
          ⏮ Start
        </button>
        
        <button
          onClick={() => onIndexChange(snapshots.length - 1)}
          disabled={currentIndex === snapshots.length - 1}
          className="px-2 py-1 bg-gray-200 rounded hover:bg-gray-300 disabled:opacity-50 text-sm"
        >
          ⏭ End
        </button>
      </div>
      
      <input
        type="range"
        min="0"
        max={snapshots.length - 1}
        value={currentIndex}
        onChange={(e) => onIndexChange(parseInt(e.target.value))}
        className="w-full"
      />
      
      <div className="flex justify-between text-xs text-gray-500 mt-1">
        <span>{currentIndex + 1} / {snapshots.length}</span>
        <span>
          {new Date(snapshots[0].timestamp).toLocaleDateString()} - {' '}
          {new Date(snapshots[snapshots.length - 1].timestamp).toLocaleDateString()}
        </span>
      </div>
    </div>
  );
};

/**
 * Main heatmap component
 */
export const PriceHeatmap: React.FC<PriceHeatmapProps> = ({
  autoUpdate = true,
  updateInterval = 5000
}) => {
  const [heatmapData, setHeatmapData] = useState<HeatmapData | null>(null);
  const [historicalData, setHistoricalData] = useState<PriceSnapshot[]>([]);
  const [isHistoricalMode, setIsHistoricalMode] = useState(false);
  const [currentSnapshotIndex, setCurrentSnapshotIndex] = useState(0);
  const [isPlaying, setIsPlaying] = useState(false);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [selectedZone, setSelectedZone] = useState<GridZone | null>(null);

  // Fetch current heatmap data
  const fetchHeatmapData = useCallback(async () => {
    try {
      const response = await fetch('/api/heatmap/current');
      const data = await response.json();
      
      if (data.success) {
        setHeatmapData({
          zones: data.zones,
          priceRange: data.priceRange,
          timestamp: new Date(data.timestamp)
        });
        setError(null);
      }
    } catch (err) {
      setError('Failed to fetch heatmap data');
      console.error('Error fetching heatmap data:', err);
    } finally {
      setLoading(false);
    }
  }, []);

  // Fetch historical data
  const fetchHistoricalData = useCallback(async () => {
    try {
      const endTime = new Date();
      const startTime = new Date(endTime.getTime() - 24 * 60 * 60 * 1000); // Last 24 hours
      
      const response = await fetch(
        `/api/heatmap/historical?startTime=${startTime.toISOString()}&endTime=${endTime.toISOString()}`
      );
      const data = await response.json();
      
      if (data.success && data.snapshots.length > 0) {
        setHistoricalData(data.snapshots);
      }
    } catch (err) {
      console.error('Error fetching historical data:', err);
    }
  }, []);

  // Initial data load
  useEffect(() => {
    fetchHeatmapData();
    fetchHistoricalData();
  }, [fetchHeatmapData, fetchHistoricalData]);

  // Auto-update current data
  useEffect(() => {
    if (!autoUpdate || isHistoricalMode) return;

    const interval = setInterval(fetchHeatmapData, updateInterval);
    return () => clearInterval(interval);
  }, [autoUpdate, updateInterval, isHistoricalMode, fetchHeatmapData]);

  // Playback control
  useEffect(() => {
    if (!isPlaying || !isHistoricalMode) return;

    const interval = setInterval(() => {
      setCurrentSnapshotIndex(prev => {
        if (prev >= historicalData.length - 1) {
          setIsPlaying(false);
          return prev;
        }
        return prev + 1;
      });
    }, 1000);

    return () => clearInterval(interval);
  }, [isPlaying, isHistoricalMode, historicalData.length]);

  // Get display data (current or historical)
  const displayData = useMemo(() => {
    if (!heatmapData) return null;

    if (isHistoricalMode && historicalData.length > 0) {
      const snapshot = historicalData[currentSnapshotIndex];
      const zones = heatmapData.zones.map(zone => ({
        ...zone,
        price: snapshot.prices[zone.id] || zone.price
      }));

      // Recalculate price range for snapshot
      const prices = zones.map(z => z.price);
      const priceRange = {
        min: Math.min(...prices),
        max: Math.max(...prices)
      };

      return { zones, priceRange, timestamp: new Date(snapshot.timestamp) };
    }

    return heatmapData;
  }, [heatmapData, isHistoricalMode, historicalData, currentSnapshotIndex]);

  if (loading) {
    return (
      <div className="flex items-center justify-center h-[600px] bg-gray-100 rounded-lg">
        <div className="text-center">
          <div className="animate-spin rounded-full h-12 w-12 border-b-2 border-blue-500 mx-auto mb-4"></div>
          <p className="text-gray-600">Loading heatmap...</p>
        </div>
      </div>
    );
  }

  if (error || !displayData) {
    return (
      <div className="flex items-center justify-center h-[600px] bg-gray-100 rounded-lg">
        <div className="text-center text-red-600">
          <p className="text-xl mb-2">⚠️ Error</p>
          <p>{error || 'Failed to load heatmap data'}</p>
          <button
            onClick={fetchHeatmapData}
            className="mt-4 px-4 py-2 bg-blue-500 text-white rounded hover:bg-blue-600"
          >
            Retry
          </button>
        </div>
      </div>
    );
  }

  const center: LatLngExpression = [37.7749, -122.4194]; // Default center

  return (
    <div className="relative w-full h-[600px] rounded-lg overflow-hidden shadow-lg">
      {/* Controls */}
      <div className="absolute top-4 right-4 z-[1000] flex gap-2">
        <button
          onClick={() => {
            setIsHistoricalMode(!isHistoricalMode);
            setIsPlaying(false);
            setCurrentSnapshotIndex(0);
          }}
          className={`px-4 py-2 rounded shadow-lg ${
            isHistoricalMode 
              ? 'bg-orange-500 text-white' 
              : 'bg-white text-gray-700 hover:bg-gray-100'
          }`}
        >
          {isHistoricalMode ? '📊 Live Mode' : '⏱️ Historical'}
        </button>
        
        <button
          onClick={fetchHeatmapData}
          className="px-4 py-2 bg-white rounded shadow-lg hover:bg-gray-100"
          title="Refresh"
        >
          🔄
        </button>
      </div>

      {/* Map */}
      <MapContainer
        center={center}
        zoom={10}
        style={{ height: '100%', width: '100%' }}
        className="z-0"
      >
        <TileLayer
          attribution='&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a>'
          url="https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png"
        />

        {/* Render zone circles */}
        {displayData.zones.map((zone) => {
          const color = getPriceColor(
            zone.price,
            displayData.priceRange.min,
            displayData.priceRange.max
          );

          return (
            <CircleMarker
              key={zone.id}
              center={[zone.lat, zone.lon]}
              radius={15}
              pathOptions={{
                fillColor: color,
                fillOpacity: 0.6,
                color: color,
                weight: 2
              }}
              eventHandlers={{
                click: () => setSelectedZone(zone)
              }}
            >
              <Popup>
                <div className="p-2">
                  <h3 className="font-bold text-lg">{zone.name}</h3>
                  <p className="text-sm text-gray-600">{zone.region}</p>
                  <div className="mt-2 space-y-1">
                    <p className="text-sm">
                      <span className="font-semibold">Price:</span> ${zone.price.toFixed(4)}/kWh
                    </p>
                    <p className="text-sm">
                      <span className="font-semibold">Location:</span> {zone.lat.toFixed(4)}, {zone.lon.toFixed(4)}
                    </p>
                  </div>
                </div>
              </Popup>
            </CircleMarker>
          );
        })}
      </MapContainer>

      {/* Legend */}
      <PriceLegend min={displayData.priceRange.min} max={displayData.priceRange.max} />

      {/* Timeline Control (only in historical mode) */}
      {isHistoricalMode && historicalData.length > 0 && (
        <TimelineControl
          snapshots={historicalData}
          currentIndex={currentSnapshotIndex}
          onIndexChange={setCurrentSnapshotIndex}
          isPlaying={isPlaying}
          onPlayPause={() => setIsPlaying(!isPlaying)}
        />
      )}

      {/* Status Badge */}
      <div className="absolute top-4 left-4 z-[1000] bg-white px-3 py-2 rounded shadow-lg">
        <div className="flex items-center gap-2">
          <div className={`w-2 h-2 rounded-full ${isHistoricalMode ? 'bg-orange-500' : 'bg-green-500'} animate-pulse`}></div>
          <span className="text-sm font-medium">
            {isHistoricalMode ? 'Historical' : 'Live'} • {displayData.zones.length} zones
          </span>
        </div>
        <div className="text-xs text-gray-500 mt-1">
          {displayData.timestamp.toLocaleTimeString()}
        </div>
      </div>
    </div>
  );
};

export default PriceHeatmap;
