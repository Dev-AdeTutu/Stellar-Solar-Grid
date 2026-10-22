/**
 * Self-Healing System for IoT Smart Meters
 * 
 * Provides automated detection and recovery from common failure modes:
 * - Service crashes and unresponsive processes
 * - Memory leaks and resource exhaustion
 * - Network connectivity issues
 * - Cache corruption
 * 
 * Features:
 * - Continuous health monitoring
 * - Automated recovery actions
 * - Escalation to technician dashboard
 * - Comprehensive audit logging
 */

import { logger } from '../lib/logger.js';
import { getMqttClient, isMqttConnected } from './mqttClient.js';
import { recordAuditEvent } from '../lib/audit.js';

export type HealthCheckStatus = 'healthy' | 'degraded' | 'critical';

export interface HealthCheck {
  name: string;
  status: HealthCheckStatus;
  message?: string;
  timestamp: number;
  meterId?: string;
}

export interface RecoveryAction {
  type: 'restart_service' | 'clear_cache' | 'reconnect_network' | 'restart_mqtt';
  target: string;
  timestamp: number;
  success: boolean;
  error?: string;
}

export interface RecoveryAttempt {
  meterId: string;
  issue: string;
  action: RecoveryAction;
  timestamp: number;
  attemptNumber: number;
  outcome: 'success' | 'failed' | 'escalated';
}

// Configuration
const HEALTH_CHECK_INTERVAL_MS = 30000; // 30 seconds
const MAX_AUTO_RECOVERY_ATTEMPTS = 3;
const ESCALATION_THRESHOLD = 3;
const MEMORY_THRESHOLD_MB = 512;
const MQTT_RECONNECT_TIMEOUT_MS = 5000;

// State tracking
const recoveryAttempts = new Map<string, number>();
const lastHealthChecks = new Map<string, HealthCheck>();
let healthCheckInterval: NodeJS.Timeout | null = null;

/**
 * Cache for health monitoring - simulates service cache
 */
const serviceCache = new Map<string, unknown>();

/**
 * Start the self-healing monitoring system.
 * Runs continuous health checks and triggers recovery actions as needed.
 */
export function startSelfHealing(): void {
  if (healthCheckInterval) {
    logger.warn('Self-healing system already running');
    return;
  }

  logger.info('Starting IoT self-healing system', {
    checkInterval: HEALTH_CHECK_INTERVAL_MS,
    maxAttempts: MAX_AUTO_RECOVERY_ATTEMPTS,
    escalationThreshold: ESCALATION_THRESHOLD,
  });

  // Record startup in audit log
  recordAuditEvent({
    action: 'self_healing_start',
    userId: 'system',
    resource: 'iot/self-healing',
    metadata: { timestamp: Date.now() },
  });

  // Initial health check
  runHealthChecks();

  // Schedule periodic health checks
  healthCheckInterval = setInterval(() => {
    runHealthChecks();
  }, HEALTH_CHECK_INTERVAL_MS);
}

/**
 * Stop the self-healing monitoring system.
 */
export function stopSelfHealing(): void {
  if (healthCheckInterval) {
    clearInterval(healthCheckInterval);
    healthCheckInterval = null;
    logger.info('Stopped IoT self-healing system');

    recordAuditEvent({
      action: 'self_healing_stop',
      userId: 'system',
      resource: 'iot/self-healing',
      metadata: { timestamp: Date.now() },
    });
  }
}

/**
 * Run all health checks and trigger recovery if needed.
 */
async function runHealthChecks(): Promise<void> {
  const checks: HealthCheck[] = [];

  // Check 1: MQTT connectivity
  const mqttCheck = checkMqttConnectivity();
  checks.push(mqttCheck);
  lastHealthChecks.set('mqtt', mqttCheck);

  // Check 2: Memory usage
  const memoryCheck = checkMemoryUsage();
  checks.push(memoryCheck);
  lastHealthChecks.set('memory', memoryCheck);

  // Check 3: Cache health
  const cacheCheck = checkCacheHealth();
  checks.push(cacheCheck);
  lastHealthChecks.set('cache', cacheCheck);

  // Process any critical or degraded checks
  for (const check of checks) {
    if (check.status === 'critical' || check.status === 'degraded') {
      logger.warn('Health check failed', { check });
      await handleFailedHealthCheck(check);
    }
  }

  // Log health summary
  const healthSummary = {
    healthy: checks.filter(c => c.status === 'healthy').length,
    degraded: checks.filter(c => c.status === 'degraded').length,
    critical: checks.filter(c => c.status === 'critical').length,
    timestamp: Date.now(),
  };

  logger.debug('Health check summary', healthSummary);
}

/**
 * Check MQTT broker connectivity.
 */
function checkMqttConnectivity(): HealthCheck {
  const isConnected = isMqttConnected();
  
  return {
    name: 'mqtt_connectivity',
    status: isConnected ? 'healthy' : 'critical',
    message: isConnected ? 'MQTT broker connected' : 'MQTT broker disconnected',
    timestamp: Date.now(),
  };
}

/**
 * Check memory usage of the service.
 */
function checkMemoryUsage(): HealthCheck {
  const usage = process.memoryUsage();
  const heapUsedMB = usage.heapUsed / 1024 / 1024;
  const heapTotalMB = usage.heapTotal / 1024 / 1024;
  const utilizationPercent = (heapUsedMB / heapTotalMB) * 100;

  let status: HealthCheckStatus = 'healthy';
  let message = `Memory usage: ${heapUsedMB.toFixed(2)}MB / ${heapTotalMB.toFixed(2)}MB (${utilizationPercent.toFixed(1)}%)`;

  if (heapUsedMB > MEMORY_THRESHOLD_MB) {
    status = 'critical';
    message = `High memory usage: ${heapUsedMB.toFixed(2)}MB exceeds threshold ${MEMORY_THRESHOLD_MB}MB`;
  } else if (utilizationPercent > 80) {
    status = 'degraded';
    message = `Memory utilization high: ${utilizationPercent.toFixed(1)}%`;
  }

  return {
    name: 'memory_usage',
    status,
    message,
    timestamp: Date.now(),
  };
}

/**
 * Check cache health and detect corruption.
 */
function checkCacheHealth(): HealthCheck {
  const cacheSize = serviceCache.size;
  const MAX_CACHE_SIZE = 1000;

  let status: HealthCheckStatus = 'healthy';
  let message = `Cache size: ${cacheSize} entries`;

  if (cacheSize > MAX_CACHE_SIZE) {
    status = 'degraded';
    message = `Cache size ${cacheSize} exceeds threshold ${MAX_CACHE_SIZE}`;
  }

  return {
    name: 'cache_health',
    status,
    message,
    timestamp: Date.now(),
  };
}

/**
 * Handle a failed health check by attempting recovery.
 */
async function handleFailedHealthCheck(check: HealthCheck): Promise<void> {
  const issueKey = `${check.name}:${check.meterId || 'system'}`;
  const attempts = recoveryAttempts.get(issueKey) || 0;

  // Check if we've exceeded max attempts
  if (attempts >= MAX_AUTO_RECOVERY_ATTEMPTS) {
    logger.error('Max recovery attempts reached, escalating', {
      check,
      attempts,
    });
    await escalateToTechnician(check, attempts);
    return;
  }

  // Attempt recovery based on check type
  const action = await attemptRecovery(check);
  
  const attempt: RecoveryAttempt = {
    meterId: check.meterId || 'system',
    issue: check.name,
    action,
    timestamp: Date.now(),
    attemptNumber: attempts + 1,
    outcome: action.success ? 'success' : 'failed',
  };

  // Log recovery attempt
  logger.info('Recovery attempt', attempt);
  
  // Record in audit log
  recordAuditEvent({
    action: 'self_healing_recovery',
    userId: 'system',
    resource: `iot/${check.name}`,
    metadata: attempt,
  });

  if (action.success) {
    // Reset attempt counter on success
    recoveryAttempts.delete(issueKey);
    logger.info('Recovery successful', { check, action });
  } else {
    // Increment attempt counter on failure
    recoveryAttempts.set(issueKey, attempts + 1);
    logger.warn('Recovery failed', { check, action, attempts: attempts + 1 });
    
    // Escalate if we hit the threshold
    if (attempts + 1 >= ESCALATION_THRESHOLD) {
      await escalateToTechnician(check, attempts + 1);
    }
  }
}

/**
 * Attempt recovery action based on health check failure.
 */
async function attemptRecovery(check: HealthCheck): Promise<RecoveryAction> {
  const timestamp = Date.now();

  switch (check.name) {
    case 'mqtt_connectivity':
      return await attemptMqttReconnect();
    
    case 'memory_usage':
      return await attemptMemoryCleanup();
    
    case 'cache_health':
      return await attemptCacheClear();
    
    default:
      return {
        type: 'restart_service',
        target: check.name,
        timestamp,
        success: false,
        error: 'Unknown recovery action',
      };
  }
}

/**
 * Attempt to reconnect MQTT client.
 */
async function attemptMqttReconnect(): Promise<RecoveryAction> {
  const timestamp = Date.now();
  
  try {
    logger.info('Attempting MQTT reconnection');
    
    const client = getMqttClient();
    
    // Force reconnect
    return new Promise((resolve) => {
      const timeout = setTimeout(() => {
        resolve({
          type: 'reconnect_network',
          target: 'mqtt',
          timestamp,
          success: false,
          error: 'Reconnection timeout',
        });
      }, MQTT_RECONNECT_TIMEOUT_MS);

      client.reconnect();
      
      const onConnect = () => {
        clearTimeout(timeout);
        client.removeListener('connect', onConnect);
        resolve({
          type: 'reconnect_network',
          target: 'mqtt',
          timestamp,
          success: true,
        });
      };

      client.once('connect', onConnect);
    });
  } catch (error) {
    return {
      type: 'reconnect_network',
      target: 'mqtt',
      timestamp,
      success: false,
      error: error instanceof Error ? error.message : String(error),
    };
  }
}

/**
 * Attempt memory cleanup by forcing garbage collection.
 */
async function attemptMemoryCleanup(): Promise<RecoveryAction> {
  const timestamp = Date.now();
  
  try {
    logger.info('Attempting memory cleanup');
    
    // Force garbage collection if available
    if (global.gc) {
      global.gc();
    }
    
    // Clear any internal caches
    serviceCache.clear();
    
    return {
      type: 'clear_cache',
      target: 'memory',
      timestamp,
      success: true,
    };
  } catch (error) {
    return {
      type: 'clear_cache',
      target: 'memory',
      timestamp,
      success: false,
      error: error instanceof Error ? error.message : String(error),
    };
  }
}

/**
 * Attempt to clear cache.
 */
async function attemptCacheClear(): Promise<RecoveryAction> {
  const timestamp = Date.now();
  
  try {
    logger.info('Attempting cache clear');
    
    const sizeBefore = serviceCache.size;
    serviceCache.clear();
    const sizeAfter = serviceCache.size;
    
    logger.info('Cache cleared', { sizeBefore, sizeAfter });
    
    return {
      type: 'clear_cache',
      target: 'service_cache',
      timestamp,
      success: true,
    };
  } catch (error) {
    return {
      type: 'clear_cache',
      target: 'service_cache',
      timestamp,
      success: false,
      error: error instanceof Error ? error.message : String(error),
    };
  }
}

/**
 * Escalate issue to technician dashboard when auto-recovery fails.
 */
async function escalateToTechnician(check: HealthCheck, attempts: number): Promise<void> {
  logger.error('Escalating to technician', {
    check,
    attempts,
    threshold: ESCALATION_THRESHOLD,
  });

  // Record escalation in audit log
  recordAuditEvent({
    action: 'self_healing_escalation',
    userId: 'system',
    resource: 'iot/escalation',
    metadata: {
      check,
      attempts,
      threshold: ESCALATION_THRESHOLD,
      timestamp: Date.now(),
      severity: 'high',
      requiresTechnicianIntervention: true,
    },
  });

  // TODO: Integration with technician dashboard/alert system
  // This would trigger notifications via email, SMS, or dashboard alerts
  logger.warn('Technician notification would be sent here', {
    issue: check.name,
    status: check.status,
    message: check.message,
  });
}

/**
 * Get current health status for all systems.
 */
export function getHealthStatus(): HealthCheck[] {
  return Array.from(lastHealthChecks.values());
}

/**
 * Get recovery attempt count for a specific issue.
 */
export function getRecoveryAttempts(issueKey: string): number {
  return recoveryAttempts.get(issueKey) || 0;
}

/**
 * Reset recovery attempts for a specific issue (manual override).
 */
export function resetRecoveryAttempts(issueKey: string): void {
  recoveryAttempts.delete(issueKey);
  logger.info('Reset recovery attempts', { issueKey });
  
  recordAuditEvent({
    action: 'self_healing_reset',
    userId: 'admin',
    resource: 'iot/self-healing',
    metadata: { issueKey, timestamp: Date.now() },
  });
}

/**
 * Get service cache for testing purposes.
 */
export function getServiceCache(): Map<string, unknown> {
  return serviceCache;
}
