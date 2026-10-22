import { EventEmitter } from 'events';
import { logger } from './logger';
import { auditTrail } from './auditTrail';
import { deviceRegistry } from './deviceRegistry';
import { emailNotifications } from './emailNotifications';
import { pushNotifications } from './pushNotifications';

/**
 * Meter Cybersecurity Threat Detection
 *
 * Provides rule-based and anomaly-based intrusion detection for IoT meters
 * communicating over MQTT, with automated response (quarantine), alerting,
 * and forensic log collection.
 */

export type ThreatType =
  | 'port_scan'
  | 'brute_force'
  | 'command_injection'
  | 'suspicious_mqtt'
  | 'anomaly'
  | 'unknown';

export type ThreatSeverity = 'low' | 'medium' | 'high' | 'critical';

export interface MqttEvent {
  meterId: string;
  topic: string;
  payload: string;
  clientId?: string;
  ip?: string;
  timestamp?: number;
  qos?: number;
  retain?: boolean;
}

export interface ThreatDetectionResult {
  detected: boolean;
  threats: Threat[];
  quarantined: boolean;
}

export interface Threat {
  id: string;
  type: ThreatType;
  severity: ThreatSeverity;
  meterId: string;
  ip?: string;
  topic?: string;
  description: string;
  evidence: Record<string, unknown>;
  timestamp: number;
}

export interface ThreatDetectionConfig {
  /** Sliding window (ms) for rate-based detections. */
  windowMs: number;
  /** Max distinct topics per meter within window before flagging port scan. */
  portScanTopicThreshold: number;
  /** Max failed auth attempts within window before flagging brute force. */
  bruteForceThreshold: number;
  /** Anomaly score threshold (0-1) above which an event is flagged. */
  anomalyThreshold: number;
  /** Whether to auto-quarantine on high/critical threats. */
  autoQuarantine: boolean;
  /** Severities that trigger auto-quarantine. */
  quarantineSeverities: ThreatSeverity[];
  /** Whether to send alerts to the security team. */
  alertingEnabled: boolean;
}

const DEFAULT_CONFIG: ThreatDetectionConfig = {
  windowMs: 60_000,
  portScanTopicThreshold: 20,
  bruteForceThreshold: 5,
  anomalyThreshold: 0.8,
  autoQuarantine: true,
  quarantineSeverities: ['high', 'critical'],
  alertingEnabled: true,
};

// ---------------------------------------------------------------------------
// Command injection signatures
// ---------------------------------------------------------------------------

const COMMAND_INJECTION_PATTERNS: RegExp[] = [
  /[;&|`]\s*(?:sh|bash|cmd|powershell|nc|netcat|curl|wget|python|perl)\b/i,
  /\$\([^)]*\)/,
  /`[^`]*`/,
  /\|\s*(?:sh|bash|nc|netcat)\b/i,
  /(?:;|&&|\|\|)\s*(?:rm|cat|ls|whoami|id|uname|chmod|chown)\b/i,
  /\.\.\/\.\.\//,
  /(?:union\s+select|drop\s+table|insert\s+into)/i,
  /<script[^>]*>/i,
  /\b(?:eval|exec|system|popen|subprocess)\s*\(/i,
  /\$\{[^}]*\}/,
];

// ---------------------------------------------------------------------------
// Internal state
// ---------------------------------------------------------------------------

interface MeterState {
  topics: Map<string, number>;
  authFailures: number[];
  eventTimestamps: number[];
  lastSeen: number;
  quarantined: boolean;
}

const meterStates = new Map<string, MeterState>();
const activeThreats = new Map<string, Threat>();
const quarantinedMeters = new Set<string>();

let config: ThreatDetectionConfig = { ...DEFAULT_CONFIG };

export const threatDetectionEvents = new EventEmitter();

function getState(meterId: string): MeterState {
  let state = meterStates.get(meterId);
  if (!state) {
    state = {
      topics: new Map(),
      authFailures: [],
      eventTimestamps: [],
      lastSeen: Date.now(),
      quarantined: false,
    };
    meterStates.set(meterId, state);
  }
  return state;
}

function pruneWindow(arr: number[], now: number, windowMs: number): number[] {
  return arr.filter((t) => now - t <= windowMs);
}

function generateId(): string {
  return `threat_${Date.now()}_${Math.random().toString(36).slice(2, 10)}`;
}

// ---------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------

export function configureThreatDetection(
  overrides: Partial<ThreatDetectionConfig>,
): void {
  config = { ...config, ...overrides };
  logger.info('Threat detection configured', { config });
}

export function getThreatDetectionConfig(): ThreatDetectionConfig {
  return { ...config };
}

// ---------------------------------------------------------------------------
// Rule-based detection
// ---------------------------------------------------------------------------

function detectCommandInjection(event: MqttEvent): Threat | null {
  const haystack = `${event.topic} ${event.payload}`;
  for (const pattern of COMMAND_INJECTION_PATTERNS) {
    if (pattern.test(haystack)) {
      return {
        id: generateId(),
        type: 'command_injection',
        severity: 'critical',
        meterId: event.meterId,
        ip: event.ip,
        topic: event.topic,
        description: `Command injection signature matched: ${pattern}`,
        evidence: {
          pattern: pattern.toString(),
          topic: event.topic,
          payload: truncate(event.payload, 512),
        },
        timestamp: event.timestamp ?? Date.now(),
      };
    }
  }
  return null;
}

function detectPortScan(event: MqttEvent, state: MeterState, now: number): Threat | null {
  state.topics.set(event.topic, now);
  // prune stale topics
  for (const [topic, ts] of state.topics) {
    if (now - ts > config.windowMs) state.topics.delete(topic);
  }
  if (state.topics.size >= config.portScanTopicThreshold) {
    return {
      id: generateId(),
      type: 'port_scan',
      severity: 'high',
      meterId: event.meterId,
      ip: event.ip,
      topic: event.topic,
      description: `Port scanning detected: ${state.topics.size} distinct topics in ${config.windowMs}ms`,
      evidence: {
        distinctTopics: state.topics.size,
        windowMs: config.windowMs,
        sampleTopics: Array.from(state.topics.keys()).slice(0, 20),
      },
      timestamp: now,
    };
  }
  return null;
}

function detectBruteForce(event: MqttEvent, state: MeterState, now: number): Threat | null {
  const isAuthFailure =
    /auth|login|credential|password|token/i.test(event.topic) &&
    /fail|denied|invalid|unauthori[sz]ed|401|403/i.test(event.payload);

  if (!isAuthFailure) return null;

  state.authFailures = pruneWindow(state.authFailures, now, config.windowMs);
  state.authFailures.push(now);

  if (state.authFailures.length >= config.bruteForceThreshold) {
    return {
      id: generateId(),
      type: 'brute_force',
      severity: 'high',
      meterId: event.meterId,
      ip: event.ip,
      topic: event.topic,
      description: `Brute force detected: ${state.authFailures.length} auth failures in ${config.windowMs}ms`,
      evidence: {
        failures: state.authFailures.length,
        windowMs: config.windowMs,
        topic: event.topic,
      },
      timestamp: now,
    };
  }
  return null;
}

function detectSuspiciousMqtt(event: MqttEvent): Threat | null {
  const suspicious: string[] = [];

  if (event.topic.includes('#') || event.topic.includes('+')) {
    suspicious.push('wildcard_topic');
  }
  if (event.topic.startsWith('$SYS/') && event.meterId) {
    suspicious.push('sys_topic_access');
  }
  if (event.payload.length > 64 * 1024) {
    suspicious.push('oversized_payload');
  }
  if (/[\x00-\x08\x0b\x0c\x0e-\x1f]/.test(event.payload)) {
    suspicious.push('control_characters');
  }
  if (event.qos !== undefined && event.qos > 2) {
    suspicious.push('invalid_qos');
  }

  if (suspicious.length === 0) return null;

  return {
    id: generateId(),
    type: 'suspicious_mqtt',
    severity: suspicious.includes('sys_topic_access') ? 'high' : 'medium',
    meterId: event.meterId,
    ip: event.ip,
    topic: event.topic,
    description: `Suspicious MQTT pattern: ${suspicious.join(', ')}`,
    evidence: {
      flags: suspicious,
      topic: event.topic,
      payloadLength: event.payload.length,
    },
    timestamp: event.timestamp ?? Date.now(),
  };
}

// ---------------------------------------------------------------------------
// Anomaly-based (ML) detection
// ---------------------------------------------------------------------------

interface AnomalyFeatures {
  payloadLength: number;
  topicDepth: number;
  hourOfDay: number;
  eventRate: number;
  isRetained: number;
  qos: number;
}

function extractFeatures(event: MqttEvent, state: MeterState, now: number): AnomalyFeatures {
  const recent = pruneWindow(state.eventTimestamps, now, config.windowMs);
  return {
    payloadLength: event.payload.length,
    topicDepth: event.topic.split('/').length,
    hourOfDay: new Date(now).getHours(),
    eventRate: recent.length,
    isRetained: event.retain ? 1 : 0,
    qos: event.qos ?? 0,
  };
}

/**
 * Built-in lightweight anomaly model. Computes a normalized anomaly score
 * based on deviation from expected feature ranges. Can be replaced by an
 * external ML service by overriding `setAnomalyScorer`.
 */
type AnomalyScorer = (features: AnomalyFeatures) => number | Promise<number>;

let anomalyScorer: AnomalyScorer = defaultAnomalyScorer;

function defaultAnomalyScorer(features: AnomalyFeatures): number {
  // Simple heuristic scoring: each feature contributes a bounded deviation.
  const scores: number[] = [];

  // Payload length: normal < 4KB
  scores.push(clamp01(features.payloadLength / (16 * 1024)));

  // Topic depth: normal 2-5 levels
  if (features.topicDepth > 6) {
    scores.push(clamp01((features.topicDepth - 6) / 6));
  } else {
    scores.push(0);
  }

  // Event rate: normal < 30/min
  scores.push(clamp01(features.eventRate / 60));

  // Retained messages from meters are unusual
  scores.push(features.isRetained * 0.6);

  // QoS > 1 unusual for telemetry
  scores.push(features.qos > 1 ? 0.5 : 0);

  // Weighted average
  const weights = [0.35, 0.2, 0.25, 0.1, 0.1];
  let total = 0;
  let weightSum = 0;
  for (let i = 0; i < scores.length; i++) {
    total += scores[i] * weights[i];
    weightSum += weights[i];
  }
  return weightSum > 0 ? total / weightSum : 0;
}

function clamp01(v: number): number {
  if (Number.isNaN(v)) return 0;
  return Math.max(0, Math.min(1, v));
}

export function setAnomalyScorer(scorer: AnomalyScorer): void {
  anomalyScorer = scorer;
  logger.info('Anomaly scorer updated');
}

async function detectAnomaly(
  event: MqttEvent,
  state: MeterState,
  now: number,
): Promise<Threat | null> {
  const features = extractFeatures(event, state, now);
  let score: number;
  try {
    score = await anomalyScorer(features);
  } catch (err) {
    logger.warn('Anomaly scorer failed', { error: (err as Error).message });
    return null;
  }

  if (score >= config.anomalyThreshold) {
    return {
      id: generateId(),
      type: 'anomaly',
      severity: score >= 0.95 ? 'critical' : 'high',
      meterId: event.meterId,
      ip: event.ip,
      topic: event.topic,
      description: `Anomalous behavior detected (score=${score.toFixed(3)})`,
      evidence: { score, features },
      timestamp: now,
    };
  }
  return null;
}

// ---------------------------------------------------------------------------
// Response: quarantine, alerting, forensics
// ---------------------------------------------------------------------------

export async function quarantineMeter(
  meterId: string,
  reason: string,
  threat?: Threat,
): Promise<void> {
  if (quarantinedMeters.has(meterId)) return;

  quarantinedMeters.add(meterId);
  const state = meterStates.get(meterId);
  if (state) state.quarantined = true;

  logger.warn('Quarantining meter', { meterId, reason });

  try {
    // Revoke credentials and isolate the device.
    if (typeof (deviceRegistry as any).revokeCredentials === 'function') {
      await (deviceRegistry as any).revokeCredentials(meterId, reason);
    }
    if (typeof (deviceRegistry as any).isolateDevice === 'function') {
      await (deviceRegistry as any).isolateDevice(meterId, reason);
    } else if (typeof (deviceRegistry as any).updateStatus === 'function') {
      await (deviceRegistry as any).updateStatus(meterId, 'quarantined');
    }
  } catch (err) {
    logger.error('Failed to quarantine meter', {
      meterId,
      error: (err as Error).message,
    });
  }

  await collectForensics(meterId, 'quarantine', {
    reason,
    threat: threat ?? null,
  });

  threatDetectionEvents.emit('meter:quarantined', { meterId, reason, threat });
}

export async function releaseMeter(meterId: string, reason: string): Promise<void> {
  if (!quarantinedMeters.has(meterId)) return;
  quarantinedMeters.delete(meterId);
  const state = meterStates.get(meterId);
  if (state) state.quarantined = false;

  try {
    if (typeof (deviceRegistry as any).restoreCredentials === 'function') {
      await (deviceRegistry as any).restoreCredentials(meterId, reason);
    }
    if (typeof (deviceRegistry as any).updateStatus === 'function') {
      await (deviceRegistry as any).updateStatus(meterId, 'active');
    }
  } catch (err) {
    logger.error('Failed to release meter', {
      meterId,
      error: (err as Error).message,
    });
  }

  await collectForensics(meterId, 'release', { reason });
  threatDetectionEvents.emit('meter:released', { meterId, reason });
}

export function isMeterQuarantined(meterId: string): boolean {
  return quarantinedMeters.has(meterId);
}

async function collectForensics(
  meterId: string,
  action: string,
  details: Record<string, unknown>,
): Promise<void> {
  try {
    if (typeof (auditTrail as any).record === 'function') {
      await (auditTrail as any).record({
        category: 'security',
        action: `threat_detection.${action}`,
        actor: 'system',
        target: meterId,
        details,
        timestamp: new Date().toISOString(),
      });
    } else if (typeof (auditTrail as any).log === 'function') {
      await (auditTrail as any).log('security', `threat_detection.${action}`, {
        meterId,
        ...details,
      });
    }
  } catch (err) {
    logger.error('Failed to record forensic log', {
      meterId,
      action,
      error: (err as Error).message,
    });
  }
}

async function alertSecurityTeam(threat: Threat): Promise<void> {
  if (!config.alertingEnabled) return;

  const subject = `[SECURITY] ${threat.severity.toUpperCase()} threat on meter ${threat.meterId}`;
  const body = [
    `Threat ID: ${threat.id}`,
    `Type: ${threat.type}`,
    `Severity: ${threat.severity}`,
    `Meter: ${threat.meterId}`,
    threat.ip ? `IP: ${threat.ip}` : '',
    threat.topic ? `Topic: ${threat.topic}` : '',
    `Description: ${threat.description}`,
    `Time: ${new Date(threat.timestamp).toISOString()}`,
  ]
    .filter(Boolean)
    .join('\n');

  try {
    if (typeof (emailNotifications as any).sendSecurityAlert === 'function') {
      await (emailNotifications as any).sendSecurityAlert({ subject, body, threat });
    } else if (typeof (emailNotifications as any).send === 'function') {
      await (emailNotifications as any).send({
        to: 'security@example.com',
        subject,
        text: body,
      });
    }
  } catch (err) {
    logger.error('Failed to send security email alert', {
      error: (err as Error).message,
    });
  }

  try {
    if (typeof (pushNotifications as any).sendSecurityAlert === 'function') {
      await (pushNotifications as any).sendSecurityAlert({ title: subject, body, threat });
    } else if (typeof (pushNotifications as any).send === 'function') {
      await (pushNotifications as any).send({
        topic: 'security',
        title: subject,
        body,
      });
    }
  } catch (err) {
    logger.error('Failed to send security push alert', {
      error: (err as Error).message,
    });
  }

  threatDetectionEvents.emit('threat:alerted', threat);
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

function truncate(s: string, max: number): string {
  return s.length > max ? `${s.slice(0, max)}...` : s;
}

/**
 * Analyze a single MQTT event for threats. Runs rule-based and anomaly
 * detection, records threats, triggers automated response, and returns
 * the aggregated result.
 */
export async function analyzeMqttEvent(
  event: MqttEvent,
): Promise<ThreatDetectionResult> {
  const now = event.timestamp ?? Date.now();
  const state = getState(event.meterId);
  state.lastSeen = now;
  state.eventTimestamps = pruneWindow(state.eventTimestamps, now, config.windowMs);
  state.eventTimestamps.push(now);

  const threats: Threat[] = [];

  // Rule-based detections
  const injection = detectCommandInjection(event);
  if (injection) threats.push(injection);

  const portScan = detectPortScan(event, state, now);
  if (portScan) threats.push(portScan);

  const bruteForce = detectBruteForce(event, state, now);
  if (bruteForce) threats.push(bruteForce);

  const suspicious = detectSuspiciousMqtt(event);
  if (suspicious) threats.push(suspicious);

  // Anomaly-based detection
  const anomaly = await detectAnomaly(event, state, now);
  if (anomaly) threats.push(anomaly);

  if (threats.length === 0) {
    return { detected: false, threats: [], quarantined: state.quarantined };
  }

  let quarantined = state.quarantined;

  for (const threat of threats) {
    activeThreats.set(threat.id, threat);
    logger.warn('Threat detected', {
      id: threat.id,
      type: threat.type,
      severity: threat.severity,
      meterId: threat.meterId,
    });

    // Forensic log
    await collectForensics(threat.meterId, 'threat_detected', {
      threatId: threat.id,
      type: threat.type,
      severity: threat.severity,
      description: threat.description,
      evidence: threat.evidence,
      ip: threat.ip,
      topic: threat.topic,
    });

    // Alert security team
    await alertSecurityTeam(threat);

    // Auto-quarantine
    if (
      config.autoQuarantine &&
      config.quarantineSeverities.includes(threat.severity) &&
      !quarantined
    ) {
      await quarantineMeter(threat.meterId, `threat:${threat.type}`, threat);
      quarantined = true;
    }

    threatDetectionEvents.emit('threat:detected', threat);
  }

  return { detected: true, threats, quarantined };
}

/**
 * Express-style middleware that inspects MQTT-related request bodies and
 * blocks requests from quarantined meters.
 */
export function threatDetectionMiddleware() {
  return async (req: any, res: any, next: (err?: unknown) => void) => {
    try {
      const meterId: string | undefined =
        req.body?.meterId ?? req.params?.meterId ?? req.headers?.['x-meter-id'];

      if (meterId && isMeterQuarantined(meterId)) {
        res.status?.(403);
        res.json?.({
          error: 'meter_quarantined',
          message: 'Meter is quarantined due to a security threat.',
        });
        return;
      }

      if (req.body && req.body.topic !== undefined && meterId) {
        const result = await analyzeMqttEvent({
          meterId,
          topic: String(req.body.topic),
          payload:
            typeof req.body.payload === 'string'
              ? req.body.payload
              : JSON.stringify(req.body.payload ?? ''),
          ip: req.ip ?? req.socket?.remoteAddress,
          qos: req.body.qos,
          retain: req.body.retain,
        });

        if (result.detected) {
          (req as any).threats = result.threats;
          if (result.quarantined) {
            res.status?.(403);
            res.json?.({
              error: 'threat_detected',
              message: 'Security threat detected; meter quarantined.',
              threats: result.threats.map((t) => ({
                id: t.id,
                type: t.type,
                severity: t.severity,
              })),
            });
            return;
          }
        }
      }

      next();
    } catch (err) {
      logger.error('Threat detection middleware error', {
        error: (err as Error).message,
      });
      next(err);
    }
  };
}

// ---------------------------------------------------------------------------
// Query helpers for routes
// ---------------------------------------------------------------------------

export function getActiveThreats(): Threat[] {
  return Array.from(activeThreats.values());
}

export function getThreatsForMeter(meterId: string): Threat[] {
  return Array.from(activeThreats.values()).filter((t) => t.meterId === meterId);
}

export function getQuarantinedMeters(): string[] {
  return Array.from(quarantinedMeters);
}

export function clearThreat(threatId: string): boolean {
  return activeThreats.delete(threatId);
}

export function resetThreatDetectionState(): void {
  meterStates.clear();
  activeThreats.clear();
  quarantinedMeters.clear();
}

export const threatDetection = {
  analyzeMqttEvent,
  quarantineMeter,
  releaseMeter,
  isMeterQuarantined,
  getActiveThreats,
  getThreatsForMeter,
  getQuarantinedMeters,
  clearThreat,
  configureThreatDetection,
  getThreatDetectionConfig,
  setAnomalyScorer,
  threatDetectionMiddleware,
  resetThreatDetectionState,
  events: threatDetectionEvents,
};

export default threatDetection;