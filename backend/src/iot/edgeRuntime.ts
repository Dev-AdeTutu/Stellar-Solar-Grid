import { EventEmitter } from 'events';

/**
 * Edge Computing Runtime for Smart Meters
 *
 * Provides local ML inference, anomaly detection, and offline buffering
 * for meter readings. Results are synced to the cloud via MQTT when
 * connectivity is restored.
 */

export interface MeterReading {
  meterId: string;
  timestamp: number;
  voltage?: number;
  current?: number;
  power?: number;
  energy?: number;
  frequency?: number;
  powerFactor?: number;
  [key: string]: number | string | undefined;
}

export interface InferenceResult {
  meterId: string;
  timestamp: number;
  prediction: number;
  confidence: number;
  anomaly: boolean;
  anomalyScore: number;
  modelVersion: string;
  processedAt: number;
}

export interface EdgeModel {
  version: string;
  features: string[];
  weights: number[];
  bias: number;
  threshold: number;
  mean: number[];
  std: number[];
}

export interface EdgeRuntimeConfig {
  model: EdgeModel;
  bufferMaxSize?: number;
  anomalyThreshold?: number;
  syncBatchSize?: number;
}

export interface MqttClientLike {
  connected: boolean;
  publish: (topic: string, payload: string, opts?: unknown, cb?: (err?: Error) => void) => void;
}

export interface BufferStore {
  load: () => Promise<InferenceResult[]>;
  save: (results: InferenceResult[]) => Promise<void>;
}

const DEFAULT_BUFFER_MAX_SIZE = 10000;
const DEFAULT_SYNC_BATCH_SIZE = 100;
const SYNC_TOPIC = 'meters/edge/results';

/**
 * In-memory buffer store used when no persistent store is provided.
 */
export class InMemoryBufferStore implements BufferStore {
  private results: InferenceResult[] = [];

  async load(): Promise<InferenceResult[]> {
    return [...this.results];
  }

  async save(results: InferenceResult[]): Promise<void> {
    this.results = [...results];
  }
}

/**
 * The edge runtime holds the loaded model, the offline buffer, and the
 * MQTT client used for syncing.
 */
export class EdgeRuntime extends EventEmitter {
  private config: EdgeRuntimeConfig;
  private buffer: InferenceResult[] = [];
  private store: BufferStore;
  private mqttClient: MqttClientLike | null = null;
  private initialized = false;
  private flushing = false;

  constructor(config: EdgeRuntimeConfig, store?: BufferStore) {
    super();
    this.config = {
      bufferMaxSize: DEFAULT_BUFFER_MAX_SIZE,
      syncBatchSize: DEFAULT_SYNC_BATCH_SIZE,
      ...config,
    };
    this.store = store ?? new InMemoryBufferStore();
  }

  /**
   * Initialize the runtime: load any previously buffered results from
   * persistent storage and mark the runtime ready.
   */
  async initialize(): Promise<void> {
    if (this.initialized) {
      return;
    }
    const persisted = await this.store.load();
    this.buffer = persisted.slice(-(this.config.bufferMaxSize ?? DEFAULT_BUFFER_MAX_SIZE));
    this.initialized = true;
    this.emit('initialized', { buffered: this.buffer.length });
  }

  /**
   * Attach an MQTT client used to sync buffered results when online.
   */
  setMqttClient(client: MqttClientLike): void {
    this.mqttClient = client;
    this.emit('mqtt-attached');
  }

  isInitialized(): boolean {
    return this.initialized;
  }

  getBufferedCount(): number {
    return this.buffer.length;
  }

  getBufferedResults(): InferenceResult[] {
    return [...this.buffer];
  }

  /**
   * Run local inference on a single meter reading.
   */
  runInference(reading: MeterReading): InferenceResult {
    this.ensureInitialized();
    const model = this.config.model;
    const features = this.extractFeatures(reading, model.features);
    const normalized = this.normalize(features, model);

    let prediction = model.bias;
    for (let i = 0; i < normalized.length; i++) {
      prediction += normalized[i] * (model.weights[i] ?? 0);
    }

    const confidence = this.computeConfidence(prediction);
    const anomalyScore = this.computeAnomalyScore(normalized, model);
    const threshold = this.config.anomalyThreshold ?? model.threshold;
    const anomaly = anomalyScore > threshold;

    const result: InferenceResult = {
      meterId: reading.meterId,
      timestamp: reading.timestamp,
      prediction,
      confidence,
      anomaly,
      anomalyScore,
      modelVersion: model.version,
      processedAt: Date.now(),
    };

    this.emit('inference', result);
    return result;
  }

  /**
   * Run inference and buffer the result for later sync.
   */
  async processReading(reading: MeterReading): Promise<InferenceResult> {
    const result = this.runInference(reading);
    await this.bufferResult(result);
    return result;
  }

  /**
   * Detect anomalies in a batch of readings.
   */
  detectAnomalies(readings: MeterReading[]): InferenceResult[] {
    return readings
      .map((r) => this.runInference(r))
      .filter((r) => r.anomaly);
  }

  /**
   * Buffer a result locally. If the buffer exceeds its max size, the
   * oldest entries are dropped.
   */
  async bufferResult(result: InferenceResult): Promise<void> {
    this.buffer.push(result);
    const max = this.config.bufferMaxSize ?? DEFAULT_BUFFER_MAX_SIZE;
    if (this.buffer.length > max) {
      this.buffer = this.buffer.slice(this.buffer.length - max);
    }
    await this.store.save(this.buffer);
    this.emit('buffered', { count: this.buffer.length });
  }

  /**
   * Flush buffered results to the cloud via MQTT. Returns the number of
   * results successfully synced. If offline, returns 0 and keeps the buffer.
   */
  async flushBuffer(): Promise<number> {
    if (this.flushing) {
      return 0;
    }
    if (!this.mqttClient || !this.mqttClient.connected) {
      this.emit('sync-skipped', { reason: 'offline', count: this.buffer.length });
      return 0;
    }
    if (this.buffer.length === 0) {
      return 0;
    }

    this.flushing = true;
    const batchSize = this.config.syncBatchSize ?? DEFAULT_SYNC_BATCH_SIZE;
    let synced = 0;

    try {
      while (this.buffer.length > 0) {
        const batch = this.buffer.slice(0, batchSize);
        const payload = JSON.stringify({ results: batch });
        const ok = await this.publish(SYNC_TOPIC, payload);
        if (!ok) {
          break;
        }
        this.buffer = this.buffer.slice(batch.length);
        synced += batch.length;
        await this.store.save(this.buffer);
      }
      this.emit('synced', { count: synced, remaining: this.buffer.length });
      return synced;
    } finally {
      this.flushing = false;
    }
  }

  private publish(topic: string, payload: string): Promise<boolean> {
    return new Promise((resolve) => {
      if (!this.mqttClient) {
        resolve(false);
        return;
      }
      try {
        this.mqttClient.publish(topic, payload, { qos: 1 }, (err?: Error) => {
          resolve(!err);
        });
      } catch {
        resolve(false);
      }
    });
  }

  private ensureInitialized(): void {
    if (!this.initialized) {
      throw new Error('EdgeRuntime not initialized. Call initialize() first.');
    }
  }

  private extractFeatures(reading: MeterReading, featureNames: string[]): number[] {
    return featureNames.map((name) => {
      const value = reading[name];
      return typeof value === 'number' && Number.isFinite(value) ? value : 0;
    });
  }

  private normalize(features: number[], model: EdgeModel): number[] {
    return features.map((value, i) => {
      const mean = model.mean[i] ?? 0;
      const std = model.std[i] ?? 1;
      return std === 0 ? 0 : (value - mean) / std;
    });
  }

  private computeConfidence(prediction: number): number {
    // Squash prediction into a 0..1 confidence using a logistic curve.
    return 1 / (1 + Math.exp(-Math.abs(prediction)));
  }

  private computeAnomalyScore(normalized: number[], model: EdgeModel): number {
    // Mahalanobis-like score using normalized feature magnitude.
    let sum = 0;
    for (let i = 0; i < normalized.length; i++) {
      sum += normalized[i] * normalized[i];
    }
    const rms = Math.sqrt(sum / Math.max(1, normalized.length));
    // Blend with model bias to keep score bounded.
    return Math.min(1, rms / (1 + Math.abs(model.bias)));
  }
}

let defaultRuntime: EdgeRuntime | null = null;

/**
 * Initialize a global edge runtime instance.
 */
export async function initializeEdgeRuntime(
  config: EdgeRuntimeConfig,
  store?: BufferStore
): Promise<EdgeRuntime> {
  if (defaultRuntime) {
    return defaultRuntime;
  }
  defaultRuntime = new EdgeRuntime(config, store);
  await defaultRuntime.initialize();
  return defaultRuntime;
}

export function getEdgeRuntime(): EdgeRuntime | null {
  return defaultRuntime;
}

export function resetEdgeRuntime(): void {
  defaultRuntime = null;
}

/**
 * Run inference for a meter reading using the default runtime.
 */
export function runInference(reading: MeterReading): InferenceResult {
  return requireRuntime().runInference(reading);
}

/**
 * Process a reading and buffer the result for later sync.
 */
export async function processReading(reading: MeterReading): Promise<InferenceResult> {
  return requireRuntime().processReading(reading);
}

/**
 * Detect anomalies in a batch of readings.
 */
export function detectAnomalies(readings: MeterReading[]): InferenceResult[] {
  return requireRuntime().detectAnomalies(readings);
}

/**
 * Flush the offline buffer via MQTT.
 */
export async function flushOfflineBuffer(): Promise<number> {
  return requireRuntime().flushBuffer();
}

function requireRuntime(): EdgeRuntime {
  if (!defaultRuntime) {
    throw new Error('Edge runtime not initialized. Call initializeEdgeRuntime() first.');
  }
  return defaultRuntime;
}
```

```typescript
import {
  EdgeRuntime,
  InMemoryBufferStore,
  initializeEdgeRuntime,
  getEdgeRuntime,
  resetEdgeRuntime,
  runInference,
  processReading,
  detectAnomalies,
  flushOfflineBuffer,
  EdgeModel,
  MeterReading,
  MqttClientLike,
} from './edgeRuntime';

const model: EdgeModel = {
  version: '1.0.0',
  features: ['voltage', 'current', 'power'],
  weights: [0.5, 0.3, 0.2],
  bias: 0.1,
  threshold: 0.5,
  mean: [230, 10, 2300],
  std: [10, 2, 100],
};

function makeReading(overrides: Partial<MeterReading> = {}): MeterReading {
  return {
    meterId: 'meter-1',
    timestamp: Date.now(),
    voltage: 230,
    current: 10,
    power: 2300,
    ...overrides,
  };
}

function makeMqttClient(connected = true): MqttClientLike & { published: Array<{ topic: string; payload: string }> } {
  const published: Array<{ topic: string; payload: string }> = [];
  return {
    connected,
    published,
    publish(topic, payload, _opts, cb) {
      published.push({ topic, payload });
      if (cb) cb();
    },
  };
}

describe('EdgeRuntime', () => {
  beforeEach(() => {
    resetEdgeRuntime();
  });

  it('initializes and loads persisted buffer', async () => {
    const store = new InMemoryBufferStore();
    await store.save([
      {
        meterId: 'meter-1',
        timestamp: 1,
        prediction: 0,
        confidence: 0.5,
        anomaly: false,
        anomalyScore: 0.1,
        modelVersion: '1.0.0',
        processedAt: 1,
      },
    ]);
    const runtime = new EdgeRuntime({ model }, store);
    await runtime.initialize();
    expect(runtime.isInitialized()).toBe(true);
    expect(runtime.getBufferedCount()).toBe(1);
  });

  it('throws when running inference before initialization', () => {
    const runtime = new EdgeRuntime({ model });
    expect(() => runtime.runInference(makeReading())).toThrow(/not initialized/);
  });

  it('runs local inference and returns a result', async () => {
    const runtime = new EdgeRuntime({ model });
    await runtime.initialize();
    const result = runtime.runInference(makeReading());
    expect(result.meterId).toBe('meter-1');
    expect(result.modelVersion).toBe('1.0.0');
    expect(result.confidence).toBeGreaterThan(0);
    expect(result.confidence).toBeLessThanOrEqual(1);
    expect(typeof result.anomaly).toBe('boolean');
  });

  it('detects anomalies for out-of-range readings', async () => {
    const runtime = new EdgeRuntime({ model, anomalyThreshold: 0.2 });
    await runtime.initialize();
    const normal = runtime.runInference(makeReading());
    const anomalous = runtime.runInference(makeReading({ voltage: 400, current: 50, power: 20000 }));
    expect(anomalous.anomalyScore).toBeGreaterThan(normal.anomalyScore);
    expect(anomalous.anomaly).toBe(true);
  });

  it('buffers results and respects max size', async () => {
    const runtime = new EdgeRuntime({ model, bufferMaxSize: 2 });
    await runtime.initialize();
    await runtime.processReading(makeReading({ timestamp: 1 }));
    await runtime.processReading(makeReading({ timestamp: 2 }));
    await runtime.processReading(makeReading({ timestamp: 3 }));
    expect(runtime.getBufferedCount()).toBe(2);
    const buffered = runtime.getBufferedResults();
    expect(buffered[0].timestamp).toBe(2);
    expect(buffered[1].timestamp).toBe(3);
  });

  it('does not flush when offline', async () => {
    const runtime = new EdgeRuntime({ model });
    await runtime.initialize();
    await runtime.processReading(makeReading());
    const client = makeMqttClient(false);
    runtime.setMqttClient(client);
    const synced = await runtime.flushBuffer();
    expect(synced).toBe(0);
    expect(runtime.getBufferedCount()).toBe(1);
    expect(client.published).toHaveLength(0);
  });

  it('flushes buffered results when online', async () => {
    const runtime = new EdgeRuntime({ model, syncBatchSize: 2 });
    await runtime.initialize();
    await runtime.processReading(makeReading({ timestamp: 1 }));
    await runtime.processReading(makeReading({ timestamp: 2 }));
    await runtime.processReading(makeReading({ timestamp: 3 }));
    const client = makeMqttClient(true);
    runtime.setMqttClient(client);
    const synced = await runtime.flushBuffer();
    expect(synced).toBe(3);
    expect(runtime.getBufferedCount()).toBe(0);
    expect(client.published.length).toBe(2);
    expect(client.published[0].topic).toBe('meters/edge/results');
  });

  it('persists buffer to store after flush', async () => {
    const store = new InMemoryBufferStore();
    const runtime = new EdgeRuntime({ model }, store);
    await runtime.initialize();
    await runtime.processReading(makeReading());
    runtime.setMqttClient(makeMqttClient(true));
    await runtime.flushBuffer();
    const persisted = await store.load();
    expect(persisted).toHaveLength(0);
  });

  it('detectAnomalies returns only anomalous results', async () => {
    const runtime = new EdgeRuntime({ model, anomalyThreshold: 0.2 });
    await runtime.initialize();
    const results = runtime.detectAnomalies([
      makeReading({ voltage: 230, current: 10, power: 2300 }),
      makeReading({ voltage: 400, current: 50, power: 20000 }),
    ]);
    expect(results.length).toBeGreaterThanOrEqual(1);
    expect(results.every((r) => r.anomaly)).toBe(true);
  });
});

describe('module-level helpers', () => {
  beforeEach(() => {
    resetEdgeRuntime();
  });

  it('initializes a default runtime', async () => {
    const runtime = await initializeEdgeRuntime({ model });
    expect(getEdgeRuntime()).toBe(runtime);
    expect(runtime.isInitialized()).toBe(true);
  });

  it('returns same runtime on repeated initialization', async () => {
    const a = await initializeEdgeRuntime({ model });
    const b = await initializeEdgeRuntime({ model });
    expect(a).toBe(b);
  });

  it('throws when helpers used before initialization', () => {
    expect(() => runInference(makeReading())).toThrow(/not initialized/);
  });

  it('runs inference via helper', async () => {
    await initializeEdgeRuntime({ model });
    const result = runInference(makeReading());
    expect(result.meterId).toBe('meter-1');
  });

  it('processes reading and flushes via helpers', async () => {
    const runtime = await initializeEdgeRuntime({ model });
    await processReading(makeReading());
    expect(runtime.getBufferedCount()).toBe(1);
    runtime.setMqttClient(makeMqttClient(true));
    const synced = await flushOfflineBuffer();
    expect(synced).toBe(1);
    expect(runtime.getBufferedCount()).toBe(0);
  });

  it('detects anomalies via helper', async () => {
    await initializeEdgeRuntime({ model, anomalyThreshold: 0.2 });
    const results = detectAnomalies([
      makeReading({ voltage: 400, current: 50, power: 20000 }),
    ]);
    expect(results.length).toBe(1);
  });
});