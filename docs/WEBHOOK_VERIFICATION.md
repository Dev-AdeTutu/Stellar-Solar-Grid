# Webhook Verification Guide

## Overview

Stellar Solar Grid webhooks use HMAC-SHA256 signatures to ensure webhook payloads are authentic and haven't been tampered with. This guide shows you how to verify webhook signatures in your application.

## How Webhook Signatures Work

### Signature Algorithm

1. **Webhook Secret**: When you register a webhook, you receive a unique secret key
2. **HMAC-SHA256**: The payload is signed using HMAC-SHA256 with your secret
3. **Header**: The signature is sent in the `X-Webhook-Signature` header
4. **Format**: `sha256=<hex_encoded_signature>`

### Security Features

- **Authenticity**: Proves the webhook came from Stellar Solar Grid
- **Integrity**: Detects any tampering with the payload
- **Replay Protection**: Timestamps prevent replay attacks

## Quick Start

### 1. Register Your Webhook

```bash
curl -X POST https://api.stellarsolargrid.com/api/webhooks/low-balance \
  -H "Content-Type: application/json" \
  -H "X-Admin-Key: your_admin_key" \
  -d '{
    "webhook_url": "https://yourdomain.com/webhooks/low-balance"
  }'
```

**Save your webhook secret securely!**

### 2. Verify Incoming Webhooks

Always verify signatures before processing webhook data.

## Code Examples

### Node.js / JavaScript

```javascript
const crypto = require('crypto');

/**
 * Verify webhook signature
 * @param {string|Buffer} payload - Raw request body
 * @param {string} signature - X-Webhook-Signature header value
 * @param {string} secret - Your webhook secret
 * @returns {boolean} - True if signature is valid
 */
function verifyWebhookSignature(payload, signature, secret) {
  // Extract signature from header (format: "sha256=<signature>")
  const parts = signature.split('=');
  if (parts[0] !== 'sha256') {
    return false;
  }
  
  const receivedSignature = parts[1];
  
  // Compute expected signature
  const expectedSignature = crypto
    .createHmac('sha256', secret)
    .update(payload)
    .digest('hex');
  
  // Use constant-time comparison to prevent timing attacks
  try {
    return crypto.timingSafeEqual(
      Buffer.from(receivedSignature),
      Buffer.from(expectedSignature)
    );
  } catch (error) {
    // Signatures are different lengths
    return false;
  }
}

// Express.js example
const express = require('express');
const app = express();

app.post('/webhooks/low-balance', 
  express.raw({ type: 'application/json' }), // Get raw body
  (req, res) => {
    const signature = req.headers['x-webhook-signature'];
    const secret = process.env.WEBHOOK_SECRET;
    
    // Verify signature
    if (!verifyWebhookSignature(req.body, signature, secret)) {
      console.error('Invalid webhook signature');
      return res.status(401).send('Invalid signature');
    }
    
    // Parse and process webhook
    const payload = JSON.parse(req.body.toString());
    console.log('Valid webhook received:', payload);
    
    // Process webhook...
    handleLowBalanceAlert(payload);
    
    res.status(200).send('OK');
  }
);
```

### Python

```python
import hmac
import hashlib
import json
from flask import Flask, request, abort

def verify_webhook_signature(payload: bytes, signature: str, secret: str) -> bool:
    """
    Verify webhook signature
    
    Args:
        payload: Raw request body (bytes)
        signature: X-Webhook-Signature header value
        secret: Your webhook secret
    
    Returns:
        True if signature is valid, False otherwise
    """
    # Extract signature from header
    parts = signature.split('=')
    if len(parts) != 2 or parts[0] != 'sha256':
        return False
    
    received_signature = parts[1]
    
    # Compute expected signature
    expected_signature = hmac.new(
        secret.encode('utf-8'),
        payload,
        hashlib.sha256
    ).hexdigest()
    
    # Use constant-time comparison
    return hmac.compare_digest(received_signature, expected_signature)


# Flask example
app = Flask(__name__)

@app.route('/webhooks/low-balance', methods=['POST'])
def handle_low_balance_webhook():
    signature = request.headers.get('X-Webhook-Signature')
    secret = os.environ.get('WEBHOOK_SECRET')
    
    # Get raw request body
    payload = request.get_data()
    
    # Verify signature
    if not verify_webhook_signature(payload, signature, secret):
        app.logger.error('Invalid webhook signature')
        abort(401, 'Invalid signature')
    
    # Parse and process webhook
    data = json.loads(payload)
    app.logger.info(f'Valid webhook received: {data}')
    
    # Process webhook...
    handle_low_balance_alert(data)
    
    return 'OK', 200
```

### PHP

```php
<?php

/**
 * Verify webhook signature
 * 
 * @param string $payload Raw request body
 * @param string $signature X-Webhook-Signature header value
 * @param string $secret Your webhook secret
 * @return bool True if signature is valid
 */
function verifyWebhookSignature($payload, $signature, $secret) {
    // Extract signature from header
    $parts = explode('=', $signature, 2);
    if (count($parts) !== 2 || $parts[0] !== 'sha256') {
        return false;
    }
    
    $receivedSignature = $parts[1];
    
    // Compute expected signature
    $expectedSignature = hash_hmac('sha256', $payload, $secret);
    
    // Use constant-time comparison
    return hash_equals($expectedSignature, $receivedSignature);
}

// Usage example
$payload = file_get_contents('php://input');
$signature = $_SERVER['HTTP_X_WEBHOOK_SIGNATURE'] ?? '';
$secret = getenv('WEBHOOK_SECRET');

// Verify signature
if (!verifyWebhookSignature($payload, $signature, $secret)) {
    error_log('Invalid webhook signature');
    http_response_code(401);
    echo 'Invalid signature';
    exit;
}

// Parse and process webhook
$data = json_decode($payload, true);
error_log('Valid webhook received: ' . print_r($data, true));

// Process webhook...
handleLowBalanceAlert($data);

http_response_code(200);
echo 'OK';
?>
```

### Go

```go
package main

import (
    "crypto/hmac"
    "crypto/sha256"
    "crypto/subtle"
    "encoding/hex"
    "encoding/json"
    "fmt"
    "io"
    "log"
    "net/http"
    "os"
    "strings"
)

// VerifyWebhookSignature verifies the webhook signature
func VerifyWebhookSignature(payload []byte, signature, secret string) bool {
    // Extract signature from header
    parts := strings.SplitN(signature, "=", 2)
    if len(parts) != 2 || parts[0] != "sha256" {
        return false
    }
    
    receivedSignature := parts[1]
    
    // Compute expected signature
    mac := hmac.New(sha256.New, []byte(secret))
    mac.Write(payload)
    expectedSignature := hex.EncodeToString(mac.Sum(nil))
    
    // Use constant-time comparison
    return subtle.ConstantTimeCompare(
        []byte(receivedSignature),
        []byte(expectedSignature),
    ) == 1
}

func handleLowBalanceWebhook(w http.ResponseWriter, r *http.Request) {
    signature := r.Header.Get("X-Webhook-Signature")
    secret := os.Getenv("WEBHOOK_SECRET")
    
    // Read raw body
    payload, err := io.ReadAll(r.Body)
    if err != nil {
        log.Printf("Error reading body: %v", err)
        http.Error(w, "Bad request", http.StatusBadRequest)
        return
    }
    
    // Verify signature
    if !VerifyWebhookSignature(payload, signature, secret) {
        log.Println("Invalid webhook signature")
        http.Error(w, "Invalid signature", http.StatusUnauthorized)
        return
    }
    
    // Parse and process webhook
    var data map[string]interface{}
    if err := json.Unmarshal(payload, &data); err != nil {
        log.Printf("Error parsing JSON: %v", err)
        http.Error(w, "Bad request", http.StatusBadRequest)
        return
    }
    
    log.Printf("Valid webhook received: %+v", data)
    
    // Process webhook...
    handleLowBalanceAlert(data)
    
    w.WriteHeader(http.StatusOK)
    fmt.Fprint(w, "OK")
}

func main() {
    http.HandleFunc("/webhooks/low-balance", handleLowBalanceWebhook)
    log.Fatal(http.ListenAndServe(":8080", nil))
}
```

### Ruby

```ruby
require 'openssl'
require 'json'
require 'sinatra'

# Verify webhook signature
#
# @param payload [String] Raw request body
# @param signature [String] X-Webhook-Signature header value
# @param secret [String] Your webhook secret
# @return [Boolean] True if signature is valid
def verify_webhook_signature(payload, signature, secret)
  # Extract signature from header
  parts = signature.split('=', 2)
  return false unless parts.length == 2 && parts[0] == 'sha256'
  
  received_signature = parts[1]
  
  # Compute expected signature
  expected_signature = OpenSSL::HMAC.hexdigest(
    OpenSSL::Digest.new('sha256'),
    secret,
    payload
  )
  
  # Use constant-time comparison
  Rack::Utils.secure_compare(received_signature, expected_signature)
end

# Sinatra example
post '/webhooks/low-balance' do
  signature = request.env['HTTP_X_WEBHOOK_SIGNATURE']
  secret = ENV['WEBHOOK_SECRET']
  
  # Get raw request body
  request.body.rewind
  payload = request.body.read
  
  # Verify signature
  unless verify_webhook_signature(payload, signature, secret)
    logger.error 'Invalid webhook signature'
    halt 401, 'Invalid signature'
  end
  
  # Parse and process webhook
  data = JSON.parse(payload)
  logger.info "Valid webhook received: #{data}"
  
  # Process webhook...
  handle_low_balance_alert(data)
  
  status 200
  'OK'
end
```

## Best Practices

### 1. Always Verify Signatures

**❌ Bad:**
```javascript
app.post('/webhook', (req, res) => {
  // Processing without verification
  handleWebhook(req.body);
  res.send('OK');
});
```

**✅ Good:**
```javascript
app.post('/webhook', (req, res) => {
  if (!verifySignature(req.body, req.headers['x-webhook-signature'], secret)) {
    return res.status(401).send('Invalid signature');
  }
  handleWebhook(req.body);
  res.send('OK');
});
```

### 2. Use Constant-Time Comparison

Prevent timing attacks by using constant-time comparison functions:

- **Node.js**: `crypto.timingSafeEqual()`
- **Python**: `hmac.compare_digest()`
- **PHP**: `hash_equals()`
- **Go**: `subtle.ConstantTimeCompare()`
- **Ruby**: `Rack::Utils.secure_compare()`

### 3. Store Secrets Securely

- Use environment variables
- Never commit secrets to git
- Rotate secrets periodically
- Use secret management services (AWS Secrets Manager, HashiCorp Vault)

```bash
# .env file (add to .gitignore!)
WEBHOOK_SECRET=your_webhook_secret_here
```

### 4. Log Verification Failures

Monitor for potential attacks or misconfigurations:

```javascript
if (!verifySignature(payload, signature, secret)) {
  logger.warn('Webhook signature verification failed', {
    ip: req.ip,
    timestamp: Date.now(),
    url: req.url,
  });
  return res.status(401).send('Invalid signature');
}
```

### 5. Implement Replay Protection

Check timestamp to prevent replay attacks:

```javascript
function verifyWebhookWithTimestamp(payload, signature, secret, maxAgeSeconds = 300) {
  // Verify signature first
  if (!verifyWebhookSignature(payload, signature, secret)) {
    return false;
  }
  
  // Check timestamp (assuming payload has timestamp field)
  const data = JSON.parse(payload);
  const timestamp = data.timestamp || data.sent_at;
  
  if (!timestamp) {
    return false;
  }
  
  const age = Math.abs(Date.now() - new Date(timestamp).getTime()) / 1000;
  
  // Reject if older than 5 minutes
  return age <= maxAgeSeconds;
}
```

### 6. Handle Errors Gracefully

Return appropriate HTTP status codes:

- `401 Unauthorized`: Invalid signature
- `400 Bad Request`: Malformed payload
- `500 Internal Server Error`: Processing error
- `200 OK`: Successfully processed

### 7. Idempotency

Handle duplicate webhooks gracefully:

```javascript
const processedWebhooks = new Set();

function handleWebhook(data) {
  const webhookId = data.id || `${data.meter_id}-${data.timestamp}`;
  
  if (processedWebhooks.has(webhookId)) {
    console.log('Duplicate webhook, skipping');
    return;
  }
  
  // Process webhook
  processWebhook(data);
  processedWebhooks.add(webhookId);
}
```

## Testing Webhooks

### Test Payload

```json
{
  "event": "low_balance",
  "meter_id": "METER_123",
  "balance": 50000000,
  "threshold": 100000000,
  "owner": "GXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXX",
  "timestamp": "2025-08-28T10:30:00.000Z"
}
```

### Generate Test Signature

```javascript
const crypto = require('crypto');

function generateSignature(payload, secret) {
  const signature = crypto
    .createHmac('sha256', secret)
    .update(JSON.stringify(payload))
    .digest('hex');
  
  return `sha256=${signature}`;
}

const payload = {
  event: 'low_balance',
  meter_id: 'METER_123',
  balance: 50000000,
  threshold: 100000000,
  timestamp: new Date().toISOString(),
};

const secret = 'your_webhook_secret';
const signature = generateSignature(payload, secret);

console.log('X-Webhook-Signature:', signature);
```

### Test with cURL

```bash
PAYLOAD='{"event":"low_balance","meter_id":"METER_123","balance":50000000,"timestamp":"2025-08-28T10:30:00.000Z"}'
SECRET="your_webhook_secret"

# Generate signature
SIGNATURE=$(echo -n "$PAYLOAD" | openssl dgst -sha256 -hmac "$SECRET" | sed 's/^.* //')

# Send webhook
curl -X POST https://yourdomain.com/webhooks/low-balance \
  -H "Content-Type: application/json" \
  -H "X-Webhook-Signature: sha256=$SIGNATURE" \
  -d "$PAYLOAD"
```

### Signature Calculator Tool

```html
<!DOCTYPE html>
<html>
<head>
  <title>Webhook Signature Calculator</title>
  <script src="https://cdnjs.cloudflare.com/ajax/libs/crypto-js/4.1.1/crypto-js.min.js"></script>
</head>
<body>
  <h1>Webhook Signature Calculator</h1>
  
  <label>Webhook Secret:</label><br>
  <input type="text" id="secret" style="width:500px" placeholder="your_webhook_secret"><br><br>
  
  <label>Payload (JSON):</label><br>
  <textarea id="payload" rows="10" style="width:500px">
{
  "event": "low_balance",
  "meter_id": "METER_123",
  "balance": 50000000
}
  </textarea><br><br>
  
  <button onclick="calculate()">Calculate Signature</button><br><br>
  
  <label>X-Webhook-Signature Header:</label><br>
  <input type="text" id="signature" readonly style="width:500px"><br>
  
  <script>
    function calculate() {
      const secret = document.getElementById('secret').value;
      const payload = document.getElementById('payload').value;
      
      try {
        // Validate JSON
        JSON.parse(payload);
        
        // Calculate HMAC-SHA256
        const hash = CryptoJS.HmacSHA256(payload, secret);
        const signature = `sha256=${hash.toString(CryptoJS.enc.Hex)}`;
        
        document.getElementById('signature').value = signature;
      } catch (error) {
        alert('Invalid JSON: ' + error.message);
      }
    }
  </script>
</body>
</html>
```

## Troubleshooting

### Signature Verification Fails

**1. Check secret key**
- Ensure you're using the correct webhook secret
- Verify no leading/trailing whitespace

**2. Check payload**
- Use raw request body (not parsed JSON)
- Verify Content-Type is `application/json`

**3. Check header name**
- Header should be `X-Webhook-Signature`
- Case-sensitive in some frameworks

**4. Check signature format**
- Should be `sha256=<hex_signature>`
- Verify no extra whitespace

### Example Debug Script

```javascript
const crypto = require('crypto');

function debugSignature(payload, receivedSignature, secret) {
  console.log('=== Webhook Signature Debug ===');
  console.log('Payload:', payload);
  console.log('Payload type:', typeof payload);
  console.log('Payload length:', payload.length);
  console.log('Received signature:', receivedSignature);
  console.log('Secret length:', secret.length);
  
  const expectedSignature = crypto
    .createHmac('sha256', secret)
    .update(payload)
    .digest('hex');
  
  console.log('Expected signature:', `sha256=${expectedSignature}`);
  console.log('Match:', receivedSignature === `sha256=${expectedSignature}`);
}
```

## Postman Collection

Import this collection to test webhooks:

```json
{
  "info": {
    "name": "Stellar Solar Grid Webhooks",
    "schema": "https://schema.getpostman.com/json/collection/v2.1.0/collection.json"
  },
  "item": [
    {
      "name": "Low Balance Webhook",
      "event": [
        {
          "listen": "prerequest",
          "script": {
            "exec": [
              "const crypto = require('crypto-js');",
              "",
              "const secret = pm.environment.get('WEBHOOK_SECRET');",
              "const payload = pm.request.body.raw;",
              "",
              "const hash = crypto.HmacSHA256(payload, secret);",
              "const signature = `sha256=${hash.toString(crypto.enc.Hex)}`;",
              "",
              "pm.request.headers.add({",
              "  key: 'X-Webhook-Signature',",
              "  value: signature",
              "});"
            ],
            "type": "text/javascript"
          }
        }
      ],
      "request": {
        "method": "POST",
        "header": [
          {
            "key": "Content-Type",
            "value": "application/json"
          }
        ],
        "body": {
          "mode": "raw",
          "raw": "{\n  \"event\": \"low_balance\",\n  \"meter_id\": \"METER_123\",\n  \"balance\": 50000000,\n  \"threshold\": 100000000,\n  \"timestamp\": \"{{$isoTimestamp}}\"\n}"
        },
        "url": {
          "raw": "{{BASE_URL}}/webhooks/low-balance",
          "host": ["{{BASE_URL}}"],
          "path": ["webhooks", "low-balance"]
        }
      }
    }
  ]
}
```

## Security Checklist

- [ ] Webhook secret stored in environment variable
- [ ] Signature verified before processing
- [ ] Constant-time comparison used
- [ ] Timestamp checked (±5 minutes tolerance)
- [ ] Failed verifications logged
- [ ] HTTPS required for webhook endpoint
- [ ] Rate limiting implemented
- [ ] Idempotency handling in place
- [ ] Error handling doesn't leak information
- [ ] Secret rotation plan established

## Resources

- [Backend API Documentation](../backend/API.md)
- [Webhook Registration Endpoint](../backend/openapi.yaml#/webhooks)
- [Security Best Practices](./SECURITY.md)
- [HMAC-SHA256 Specification](https://tools.ietf.org/html/rfc2104)

## Support

For webhook-related issues:
1. Use the signature calculator tool to verify your implementation
2. Check server logs for verification failures
3. Review code examples for your language
4. Create GitHub issue with debug output (DO NOT include secrets!)
