# Security

This document describes the cybersecurity threat detection and response capabilities for IoT meters in the platform. It covers threat detection rules, anomaly-based intrusion detection, automated quarantine, alerting, forensic logging, the security API, and configuration.

## Overview

The meter cybersecurity subsystem provides defense-in-depth for IoT meters communicating over MQTT. It combines:

- **Rule-based threat detection** for known attack signatures (port scanning, brute force, command injection, suspicious MQTT patterns).
- **ML-based anomaly detection** to catch deviations from normal meter behavior.
- **Automated response** including quarantine of compromised meters.
- **Immediate alerting** to the security team.
- **Forensic log collection** for post-incident analysis.

The subsystem is implemented in the backend and operates on telemetry and MQTT traffic flowing through the platform.

## Threat Detection Rules

Rules are evaluated against inbound MQTT messages, connection events, and meter telemetry. Each rule produces a detection event with a severity (`low`, `medium`, `high`, `critical`), the offending meter ID, and supporting evidence.

### Suspicious MQTT Patterns

- **Malformed topics**: messages published to topics that do not match the expected `meters/<meterId>/...` scheme.
- **Unexpected publish/subscribe**: a meter publishing to command or control topics it should only subscribe to (or vice versa).
- **Wildcard abuse**: subscriptions using `#` or `+` that could intercept other meters' traffic.
- **Payload anomalies**: oversized payloads, binary payloads where JSON is expected, or repeated identical payloads at abnormal rates.
- **Retained-message abuse**: setting retained flags on telemetry topics.
- **QoS escalation**: unexpected QoS levels inconsistent with the meter's profile.

### Port Scanning

Detects a meter (or a source associated with a meter) probing multiple ports or services in a short window:

- Connection attempts to a high number of distinct ports within a configurable time window.
- Sequential or randomized port sweeps.
- Attempts to reach services outside the meter's allowed service set.

### Brute Force

Detects credential-guessing and authentication abuse:

- Repeated failed authentication attempts from the same meter or source IP.
- Multiple distinct credentials tried in a short window.
- Failed MQTT CONNECT attempts exceeding a threshold.
- Credential stuffing patterns across multiple meters from a single source.

### Command Injection

Detects attempts to inject commands through meter inputs:

- Shell metacharacters (`;`, `|`, `&&`, `` ` ``, `$()`) in command payloads or identifiers.
- Path traversal sequences (`../`) in file or topic references.
- Known injection signatures in command fields.
- Unexpected command types not in the meter's allowed command set.

## Anomaly-Based Intrusion Detection (ML)

In addition to signature rules, the platform uses ML-based anomaly detection to identify behavior that deviates from a meter's learned baseline.

### Approach

- **Feature extraction**: per-meter behavioral features are computed over sliding windows, including message rate, payload size distribution, topic distribution, connection frequency, command frequency, time-of-day activity, and error rates.
- **Baseline learning**: each meter builds a behavioral profile during a learning period. Profiles are per-meter and optionally per-device-type to improve accuracy for new meters.
- **Scoring**: incoming behavior is scored against the baseline. An anomaly score above a configurable threshold raises a detection event. Scores are continuous, allowing severity to scale with deviation.
- **Model updates**: baselines are updated incrementally to accommodate legitimate drift (e.g., firmware updates, seasonal usage) while resisting poisoning through bounded update rates.

### Severity Mapping

Anomaly scores map to severities via configurable thresholds. High-severity anomalies can trigger automated response (see below). Low-severity anomalies are logged and aggregated to reduce noise.

## Automated Response and Quarantine

When a detection meets the response criteria (severity at or above the configured threshold, or repeated detections), the platform can automatically quarantine the meter.

### Quarantine Process

1. **Detection**: a rule or anomaly triggers a detection event.
2. **Decision**: the response policy evaluates severity, confidence, and repetition to decide whether to quarantine.
3. **Isolation**: the meter is placed in quarantine:
   - Its MQTT credentials/permissions are restricted so it can only reach a quarantine topic.
   - Its normal publish/subscribe access is revoked.
   - Downstream processing ignores its telemetry until released.
4. **Notification**: the security team is alerted immediately (see Alerting).
5. **Forensics**: relevant logs and evidence are collected (see Forensic Logging).
6. **Review**: operators review the incident and either release the meter (restoring access) or keep it quarantined pending remediation.

Quarantine actions are recorded with the triggering detection, timestamp, and acting policy. Manual quarantine and release are also supported via the API.

## Alerting

Detections and response actions generate alerts delivered to the security team immediately.

- **Channels**: configurable alert channels (e.g., email, webhook, SIEM integration, on-call paging).
- **Immediate delivery**: `critical` and `high` severity detections and all quarantine actions are sent without batching.
- **Deduplication**: repeated identical detections are aggregated within a configurable window to avoid alert fatigue, while still escalating on repetition.
- **Enrichment**: alerts include meter ID, detection type, severity, evidence summary, and any automated action taken.

## Forensic Logging

All security-relevant events are logged for investigation and audit.

- **What is captured**: detection events, raw evidence (message metadata, payload hashes, connection details), response actions, quarantine/release events, and configuration changes.
- **Immutability**: forensic logs are append-only and protected from modification by the monitored meters.
- **Retention**: configurable retention period; logs are retained long enough to support incident response and compliance requirements.
- **Correlation**: events are correlated by meter ID and incident ID so the full timeline of an attack can be reconstructed.
- **Export**: forensic records can be exported via the API for external analysis.

## API Endpoints

The security API exposes detection, response, and forensic capabilities. All endpoints require authentication and appropriate authorization.

| Method | Path | Description |
|--------|------|-------------|
| `GET` | `/api/security/detections` | List detection events (filter by meter, type, severity, time range). |
| `GET` | `/api/security/detections/{id}` | Get details and evidence for a detection. |
| `POST` | `/api/security/meters/{meterId}/quarantine` | Manually quarantine a meter. |
| `POST` | `/api/security/meters/{meterId}/release` | Release a meter from quarantine. |
| `GET` | `/api/security/meters/{meterId}/status` | Get a meter's security status (normal/quarantined). |
| `GET` | `/api/security/forensics` | Query forensic logs (filter by meter, incident, time range). |
| `GET` | `/api/security/forensics/{incidentId}/export` | Export forensic records for an incident. |
| `GET` | `/api/security/config` | Get current security configuration. |
| `PUT` | `/api/security/config` | Update security configuration (thresholds, response policy, alerting). |

## Configuration

Security behavior is configurable. Key settings include:

- **Detection rules**: enable/disable individual rules and set thresholds (e.g., failed-auth count, port-scan window, rate limits).
- **Anomaly detection**: enable/disable ML detection, set the learning period, anomaly score thresholds, and severity mapping.
- **Response policy**: minimum severity/confidence to auto-quarantine, repetition thresholds, and whether automated response is enabled.
- **Alerting**: channels, recipients, deduplication window, and severity filters.
- **Forensic logging**: retention period and export settings.

Configuration is managed via the `/api/security/config` endpoint and applies to new traffic after being updated. Changes to security configuration are themselves logged for audit.

## Testing

Threat detection behavior is covered by automated tests, including:

- Rule tests for suspicious MQTT patterns, port scanning, brute force, and command injection.
- Anomaly detection tests validating scoring and threshold behavior.
- Quarantine and release workflow tests.
- Alerting and forensic logging tests.

See the test suite under the backend security tests for details.