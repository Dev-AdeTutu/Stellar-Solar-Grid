# Webhook Verification Quick Reference

## TL;DR

```javascript
const crypto = require('crypto');

function verifyWebhook(payload, signature, secret) {
  const expectedSig = crypto.createHmac('sha256', secret)
    .update(payload).digest('hex');
  
  return crypto.timingSafeEqual(
    Buffer.from(signature.replace('sha256=', '')),
    Buffer.from(expectedSig)
  );
}
```

## Signature Header

```
X-Webhook-Signature: sha256=<hex_signature>
```

## Quick Implementations

### Node.js (Express)

```javascript
app.post('/webhook', 
  express.raw({ type: 'application/json' }),
  (req, res) => {
    if (!verifyWebhook(req.body, req.headers['x-webhook-signature'], SECRET)) {
      return res.status(401).send('Invalid');
    }
    handleWebhook(JSON.parse(req.body));
    res.send('OK');
  }
);
```

### Python (Flask)

```python
import hmac, hashlib

def verify(payload, sig, secret):
    expected = hmac.new(secret.encode(), payload, hashlib.sha256).hexdigest()
    return hmac.compare_digest(sig.split('=')[1], expected)

@app.route('/webhook', methods=['POST'])
def webhook():
    if not verify(request.data, request.headers['X-Webhook-Signature'], SECRET):
        return 'Invalid', 401
    handle_webhook(request.json)
    return 'OK'
```

### PHP

```php
function verify($payload, $sig, $secret) {
    $expected = hash_hmac('sha256', $payload, $secret);
    return hash_equals($expected, explode('=', $sig)[1]);
}

$payload = file_get_contents('php://input');
if (!verify($payload, $_SERVER['HTTP_X_WEBHOOK_SIGNATURE'], $secret)) {
    http_response_code(401);
    exit('Invalid');
}
```

### Go

```go
import "crypto/hmac"

func verify(payload []byte, sig, secret string) bool {
    mac := hmac.New(sha256.New, []byte(secret))
    mac.Write(payload)
    expected := hex.EncodeToString(mac.Sum(nil))
    return subtle.ConstantTimeCompare([]byte(strings.Split(sig, "=")[1]), []byte(expected)) == 1
}
```

## Test Signature Generation

```bash
# Bash
echo -n '{"meter_id":"123"}' | openssl dgst -sha256 -hmac "your_secret"

# Node.js
crypto.createHmac('sha256', secret).update(payload).digest('hex')

# Python
hmac.new(secret.encode(), payload, hashlib.sha256).hexdigest()
```

## Common Errors

| Error | Cause | Fix |
|-------|-------|-----|
| Signature mismatch | Wrong secret | Check environment variable |
| Signature mismatch | Parsed JSON used | Use raw request body |
| Header not found | Wrong header name | Use `X-Webhook-Signature` |
| Invalid format | Missing `sha256=` | Signature should be `sha256=<hex>` |

## Security Checklist

✅ Verify signature before processing  
✅ Use constant-time comparison  
✅ Check timestamp (±5 min)  
✅ Log failed verifications  
✅ Store secret in env variable  
✅ Use HTTPS endpoint  

## Full Documentation

See [WEBHOOK_VERIFICATION.md](./WEBHOOK_VERIFICATION.md) for complete guide with examples in 6 languages.
