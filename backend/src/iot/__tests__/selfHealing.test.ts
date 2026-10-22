/**
 * Tests for IoT Self-Healing System
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import {
  startSelfHealing,
  stopSelfHealing,
  getHealthStatus,
  getRecoveryAttempts,
  resetRecoveryAttempts,
  getServiceCache,
  type HealthCheck,
  type HealthCheckStatus,
} from '../selfHealing.js';
import * as mqttClient from '../mqttClient.js';
import * as audit from '../../lib/audit.js';

// Mock dependencies
vi.mock('../mqttClient.js');
vi.mock('../../lib/audit.js');
vi.mock('../../lib/logger.js', () => ({
  logger: {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  },
}));

describe('IoT Self-Healing System', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.useFakeTimers();
  });

  afterEach(() => {
    stopSelfHealing();
    vi.useRealTimers();
  });

  describe('startSelfHealing', () => {
    it('should start the self-healing system', () => {
      const recordAuditEventSpy = vi.spyOn(audit, 'recordAuditEvent');
      
      startSelfHealing();
      
      expect(recordAuditEventSpy).toHaveBeenCalledWith(
        expect.objectContaining({
          action: 'self_healing_start',
          userId: 'system',
          resource: 'iot/self-healing',
        })
      );
    });

    it('should not start if already running', () => {
      const recordAuditEventSpy = vi.spyOn(audit, 'recordAuditEvent');
      
      startSelfHealing();
      recordAuditEventSpy.mockClear();
      
      startSelfHealing();
      
      // Should not record another start event
      expect(recordAuditEventSpy).not.toHaveBeenCalled();
    });

    it('should run initial health checks immediately', () => {
      vi.spyOn(mqttClient, 'isMqttConnected').mockReturnValue(true);
      
      startSelfHealing();
      
      const healthStatus = getHealthStatus();
      expect(healthStatus.length).toBeGreaterThan(0);
    });

    it('should schedule periodic health checks', () => {
      vi.spyOn(mqttClient, 'isMqttConnected').mockReturnValue(true);
      
      startSelfHealing();
      
      // Advance time by 30 seconds (health check interval)
      vi.advanceTimersByTime(30000);
      
      const healthStatus = getHealthStatus();
      expect(healthStatus.length).toBeGreaterThan(0);
    });
  });

  describe('stopSelfHealing', () => {
    it('should stop the self-healing system', () => {
      const recordAuditEventSpy = vi.spyOn(audit, 'recordAuditEvent');
      
      startSelfHealing();
      recordAuditEventSpy.mockClear();
      
      stopSelfHealing();
      
      expect(recordAuditEventSpy).toHaveBeenCalledWith(
        expect.objectContaining({
          action: 'self_healing_stop',
          userId: 'system',
          resource: 'iot/self-healing',
        })
      );
    });

    it('should not error if called when not running', () => {
      expect(() => stopSelfHealing()).not.toThrow();
    });
  });

  describe('Health Checks', () => {
    describe('MQTT Connectivity Check', () => {
      it('should report healthy when MQTT is connected', () => {
        vi.spyOn(mqttClient, 'isMqttConnected').mockReturnValue(true);
        
        startSelfHealing();
        
        const healthStatus = getHealthStatus();
        const mqttCheck = healthStatus.find(c => c.name === 'mqtt_connectivity');
        
        expect(mqttCheck).toBeDefined();
        expect(mqttCheck?.status).toBe('healthy');
        expect(mqttCheck?.message).toContain('connected');
      });

      it('should report critical when MQTT is disconnected', () => {
        vi.spyOn(mqttClient, 'isMqttConnected').mockReturnValue(false);
        
        startSelfHealing();
        
        const healthStatus = getHealthStatus();
        const mqttCheck = healthStatus.find(c => c.name === 'mqtt_connectivity');
        
        expect(mqttCheck).toBeDefined();
        expect(mqttCheck?.status).toBe('critical');
        expect(mqttCheck?.message).toContain('disconnected');
      });
    });

    describe('Memory Usage Check', () => {
      it('should report healthy when memory usage is normal', () => {
        vi.spyOn(mqttClient, 'isMqttConnected').mockReturnValue(true);
        
        // Mock normal memory usage
        const originalMemoryUsage = process.memoryUsage;
        process.memoryUsage = vi.fn().mockReturnValue({
          heapUsed: 100 * 1024 * 1024, // 100MB
          heapTotal: 200 * 1024 * 1024, // 200MB
          external: 0,
          rss: 0,
          arrayBuffers: 0,
        });
        
        startSelfHealing();
        
        const healthStatus = getHealthStatus();
        const memoryCheck = healthStatus.find(c => c.name === 'memory_usage');
        
        expect(memoryCheck).toBeDefined();
        expect(memoryCheck?.status).toBe('healthy');
        
        process.memoryUsage = originalMemoryUsage;
      });

      it('should report critical when memory exceeds threshold', () => {
        vi.spyOn(mqttClient, 'isMqttConnected').mockReturnValue(true);
        
        // Mock high memory usage (600MB > 512MB threshold)
        const originalMemoryUsage = process.memoryUsage;
        process.memoryUsage = vi.fn().mockReturnValue({
          heapUsed: 600 * 1024 * 1024, // 600MB
          heapTotal: 800 * 1024 * 1024, // 800MB
          external: 0,
          rss: 0,
          arrayBuffers: 0,
        });
        
        startSelfHealing();
        
        const healthStatus = getHealthStatus();
        const memoryCheck = healthStatus.find(c => c.name === 'memory_usage');
        
        expect(memoryCheck).toBeDefined();
        expect(memoryCheck?.status).toBe('critical');
        expect(memoryCheck?.message).toContain('exceeds threshold');
        
        process.memoryUsage = originalMemoryUsage;
      });

      it('should report degraded when memory utilization is high', () => {
        vi.spyOn(mqttClient, 'isMqttConnected').mockReturnValue(true);
        
        // Mock high utilization (85%)
        const originalMemoryUsage = process.memoryUsage;
        process.memoryUsage = vi.fn().mockReturnValue({
          heapUsed: 425 * 1024 * 1024, // 425MB (85% of 500MB)
          heapTotal: 500 * 1024 * 1024, // 500MB
          external: 0,
          rss: 0,
          arrayBuffers: 0,
        });
        
        startSelfHealing();
        
        const healthStatus = getHealthStatus();
        const memoryCheck = healthStatus.find(c => c.name === 'memory_usage');
        
        expect(memoryCheck).toBeDefined();
        expect(memoryCheck?.status).toBe('degraded');
        
        process.memoryUsage = originalMemoryUsage;
      });
    });

    describe('Cache Health Check', () => {
      it('should report healthy when cache size is normal', () => {
        vi.spyOn(mqttClient, 'isMqttConnected').mockReturnValue(true);
        
        startSelfHealing();
        
        const healthStatus = getHealthStatus();
        const cacheCheck = healthStatus.find(c => c.name === 'cache_health');
        
        expect(cacheCheck).toBeDefined();
        expect(cacheCheck?.status).toBe('healthy');
      });

      it('should report degraded when cache size exceeds threshold', () => {
        vi.spyOn(mqttClient, 'isMqttConnected').mockReturnValue(true);
        
        // Fill cache beyond threshold (1000 entries)
        const cache = getServiceCache();
        for (let i = 0; i < 1500; i++) {
          cache.set(`key_${i}`, { data: i });
        }
        
        startSelfHealing();
        
        const healthStatus = getHealthStatus();
        const cacheCheck = healthStatus.find(c => c.name === 'cache_health');
        
        expect(cacheCheck).toBeDefined();
        expect(cacheCheck?.status).toBe('degraded');
        expect(cacheCheck?.message).toContain('exceeds threshold');
      });
    });
  });

  describe('Recovery Actions', () => {
    beforeEach(() => {
      // Mock MQTT client
      const mockClient = {
        reconnect: vi.fn(),
        once: vi.fn(),
        removeListener: vi.fn(),
      };
      vi.spyOn(mqttClient, 'getMqttClient').mockReturnValue(mockClient as any);
    });

    it('should attempt MQTT reconnection on connectivity failure', async () => {
      vi.spyOn(mqttClient, 'isMqttConnected').mockReturnValue(false);
      const getMqttClientSpy = vi.spyOn(mqttClient, 'getMqttClient');
      const recordAuditEventSpy = vi.spyOn(audit, 'recordAuditEvent');
      
      startSelfHealing();
      
      // Wait for recovery attempt
      await vi.advanceTimersByTimeAsync(100);
      
      expect(getMqttClientSpy).toHaveBeenCalled();
      expect(recordAuditEventSpy).toHaveBeenCalledWith(
        expect.objectContaining({
          action: 'self_healing_recovery',
        })
      );
    });

    it('should clear cache on cache health failure', async () => {
      vi.spyOn(mqttClient, 'isMqttConnected').mockReturnValue(true);
      
      // Fill cache beyond threshold
      const cache = getServiceCache();
      for (let i = 0; i < 1500; i++) {
        cache.set(`key_${i}`, { data: i });
      }
      
      const recordAuditEventSpy = vi.spyOn(audit, 'recordAuditEvent');
      
      startSelfHealing();
      
      // Wait for recovery attempt
      await vi.advanceTimersByTimeAsync(100);
      
      expect(recordAuditEventSpy).toHaveBeenCalledWith(
        expect.objectContaining({
          action: 'self_healing_recovery',
        })
      );
    });

    it('should attempt memory cleanup on high memory usage', async () => {
      vi.spyOn(mqttClient, 'isMqttConnected').mockReturnValue(true);
      
      // Mock high memory usage
      const originalMemoryUsage = process.memoryUsage;
      process.memoryUsage = vi.fn().mockReturnValue({
        heapUsed: 600 * 1024 * 1024,
        heapTotal: 800 * 1024 * 1024,
        external: 0,
        rss: 0,
        arrayBuffers: 0,
      });
      
      const recordAuditEventSpy = vi.spyOn(audit, 'recordAuditEvent');
      
      startSelfHealing();
      
      // Wait for recovery attempt
      await vi.advanceTimersByTimeAsync(100);
      
      expect(recordAuditEventSpy).toHaveBeenCalledWith(
        expect.objectContaining({
          action: 'self_healing_recovery',
        })
      );
      
      process.memoryUsage = originalMemoryUsage;
    });
  });

  describe('Escalation', () => {
    it('should escalate after max recovery attempts', async () => {
      vi.spyOn(mqttClient, 'isMqttConnected').mockReturnValue(false);
      const recordAuditEventSpy = vi.spyOn(audit, 'recordAuditEvent');
      
      // Mock failed reconnection attempts
      const mockClient = {
        reconnect: vi.fn(),
        once: vi.fn((event, callback) => {
          // Simulate timeout - never call the callback
        }),
        removeListener: vi.fn(),
      };
      vi.spyOn(mqttClient, 'getMqttClient').mockReturnValue(mockClient as any);
      
      startSelfHealing();
      
      // Run through multiple health check cycles to trigger escalation
      for (let i = 0; i < 4; i++) {
        await vi.advanceTimersByTimeAsync(35000); // Health check interval + recovery timeout
      }
      
      // Should have escalated
      expect(recordAuditEventSpy).toHaveBeenCalledWith(
        expect.objectContaining({
          action: 'self_healing_escalation',
          resource: 'iot/escalation',
        })
      );
    });

    it('should include escalation metadata in audit log', async () => {
      vi.spyOn(mqttClient, 'isMqttConnected').mockReturnValue(false);
      const recordAuditEventSpy = vi.spyOn(audit, 'recordAuditEvent');
      
      // Mock failed reconnection
      const mockClient = {
        reconnect: vi.fn(),
        once: vi.fn(),
        removeListener: vi.fn(),
      };
      vi.spyOn(mqttClient, 'getMqttClient').mockReturnValue(mockClient as any);
      
      startSelfHealing();
      
      // Trigger escalation
      for (let i = 0; i < 4; i++) {
        await vi.advanceTimersByTimeAsync(35000);
      }
      
      const escalationCall = recordAuditEventSpy.mock.calls.find(
        call => call[0].action === 'self_healing_escalation'
      );
      
      expect(escalationCall).toBeDefined();
      expect(escalationCall?.[0].metadata).toMatchObject({
        severity: 'high',
        requiresTechnicianIntervention: true,
      });
    });
  });

  describe('Recovery Attempt Tracking', () => {
    it('should track recovery attempts per issue', async () => {
      vi.spyOn(mqttClient, 'isMqttConnected').mockReturnValue(false);
      
      // Mock failed reconnection
      const mockClient = {
        reconnect: vi.fn(),
        once: vi.fn(),
        removeListener: vi.fn(),
      };
      vi.spyOn(mqttClient, 'getMqttClient').mockReturnValue(mockClient as any);
      
      startSelfHealing();
      
      // First attempt
      await vi.advanceTimersByTimeAsync(35000);
      let attempts = getRecoveryAttempts('mqtt_connectivity:system');
      expect(attempts).toBeGreaterThan(0);
      
      // Second attempt
      await vi.advanceTimersByTimeAsync(35000);
      attempts = getRecoveryAttempts('mqtt_connectivity:system');
      expect(attempts).toBeGreaterThan(1);
    });

    it('should reset attempts on successful recovery', async () => {
      vi.spyOn(mqttClient, 'isMqttConnected')
        .mockReturnValueOnce(false)
        .mockReturnValueOnce(true);
      
      // Mock successful reconnection
      const mockClient = {
        reconnect: vi.fn(),
        once: vi.fn((event, callback) => {
          setTimeout(callback, 10); // Simulate successful reconnect
        }),
        removeListener: vi.fn(),
      };
      vi.spyOn(mqttClient, 'getMqttClient').mockReturnValue(mockClient as any);
      
      startSelfHealing();
      
      // First check shows failure
      await vi.advanceTimersByTimeAsync(100);
      
      // Next check shows success
      await vi.advanceTimersByTimeAsync(30000);
      
      const attempts = getRecoveryAttempts('mqtt_connectivity:system');
      expect(attempts).toBe(0);
    });

    it('should allow manual reset of recovery attempts', () => {
      const issueKey = 'mqtt_connectivity:system';
      const recordAuditEventSpy = vi.spyOn(audit, 'recordAuditEvent');
      
      resetRecoveryAttempts(issueKey);
      
      expect(getRecoveryAttempts(issueKey)).toBe(0);
      expect(recordAuditEventSpy).toHaveBeenCalledWith(
        expect.objectContaining({
          action: 'self_healing_reset',
          metadata: expect.objectContaining({ issueKey }),
        })
      );
    });
  });

  describe('Audit Logging', () => {
    it('should log all recovery attempts', async () => {
      vi.spyOn(mqttClient, 'isMqttConnected').mockReturnValue(false);
      const recordAuditEventSpy = vi.spyOn(audit, 'recordAuditEvent');
      
      startSelfHealing();
      
      await vi.advanceTimersByTimeAsync(100);
      
      expect(recordAuditEventSpy).toHaveBeenCalledWith(
        expect.objectContaining({
          action: 'self_healing_recovery',
          userId: 'system',
        })
      );
    });

    it('should include detailed metadata in recovery logs', async () => {
      vi.spyOn(mqttClient, 'isMqttConnected').mockReturnValue(false);
      const recordAuditEventSpy = vi.spyOn(audit, 'recordAuditEvent');
      
      startSelfHealing();
      
      await vi.advanceTimersByTimeAsync(100);
      
      const recoveryCall = recordAuditEventSpy.mock.calls.find(
        call => call[0].action === 'self_healing_recovery'
      );
      
      expect(recoveryCall?.[0].metadata).toMatchObject({
        issue: expect.any(String),
        timestamp: expect.any(Number),
        attemptNumber: expect.any(Number),
        outcome: expect.stringMatching(/success|failed|escalated/),
      });
    });
  });

  describe('getHealthStatus', () => {
    it('should return current health status for all checks', () => {
      vi.spyOn(mqttClient, 'isMqttConnected').mockReturnValue(true);
      
      startSelfHealing();
      
      const healthStatus = getHealthStatus();
      
      expect(healthStatus).toBeInstanceOf(Array);
      expect(healthStatus.length).toBeGreaterThan(0);
      expect(healthStatus[0]).toHaveProperty('name');
      expect(healthStatus[0]).toHaveProperty('status');
      expect(healthStatus[0]).toHaveProperty('timestamp');
    });

    it('should return empty array before first health check', () => {
      const healthStatus = getHealthStatus();
      expect(healthStatus).toEqual([]);
    });
  });
});
