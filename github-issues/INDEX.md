# Issue Index - Quick Reference

## All 50 Issues by Number

### Frontend Issues (16)
| # | Type | Title | Priority |
|---|------|-------|----------|
| 001 | Feature | Payment history CSV export | Medium |
| 004 | Bug | Wallet disconnect race condition | High |
| 008 | Feature | Dark mode theme | Medium |
| 011 | Feature | French and Swahili translations | Low |
| 014 | Bug | Usage chart timezone display | Medium |
| 017 | Feature | Browser push notifications | Medium |
| 020 | Feature | QR code payment generation | Medium |
| 023 | Bug | Payment history pagination | Medium |
| 026 | Feature | Offline mode with service worker | Low |
| 029 | Feature | Custom meter nicknames | Low |
| 032 | Feature | Accessibility improvements | Medium |
| 035 | Feature | Downloadable payment receipts | Low |
| 038 | Bug | Balance display rounding errors | Medium |
| 042 | Feature | Usage forecasting | Low |
| 046 | Feature | Side-by-side meter comparison | Low |
| 047 | Feature | Quick payment amount presets | Low |

### Backend Issues (20)
| # | Type | Title | Priority |
|---|------|-------|----------|
| 002 | Bug | MQTT reconnection failure | High |
| 005 | Feature | Usage analytics and trends endpoint | Medium |
| 007 | Feature | GraphQL API | Medium |
| 009 | Bug | Idempotency cache memory leak | High |
| 012 | Feature | Per-user rate limiting | Medium |
| 015 | Feature | Exponential backoff for webhooks | Medium |
| 018 | Bug | SQL injection in meter notes | Critical |
| 021 | Feature | Detailed health check endpoint | Medium |
| 024 | Feature | Configurable CORS origins | Low |
| 027 | Bug | Memory exhaustion with large batches | High |
| 030 | Feature | API versioning strategy | Medium |
| 031 | Feature | Structured JSON logging | Medium |
| 034 | Bug | Prometheus metric race conditions | Medium |
| 037 | Feature | Request/response logging middleware | Medium |
| 039 | Feature | Usage event compression | Medium |
| 043 | Feature | Multiple RPC endpoints with failover | Medium |
| 044 | Bug | Missing webhook signature verification | Critical |
| 048 | Bug | Environment validation timing issue | Medium |
| 050 | Feature | Payment webhook notifications | Medium |

### Smart Contract Issues (14)
| # | Type | Title | Priority |
|---|------|-------|----------|
| 003 | Feature | Bulk meter deactivation | Medium |
| 006 | Bug | Integer overflow in balance calculations | Critical |
| 010 | Feature | Monthly subscription plans | Medium |
| 013 | Bug | Missing payment plan change events | Medium |
| 016 | Feature | Payment refund function | Low |
| 019 | Feature | Emergency pause mechanism | High |
| 022 | Feature | Meter ownership transfer | Medium |
| 025 | Bug | Timestamp comparison issues (DST) | Low |
| 028 | Feature | Grace period before deactivation | Medium |
| 033 | Feature | Batch meter registration | Medium |
| 036 | Bug | Missing allowlist removal function | High |
| 040 | Feature | Emergency admin fund withdrawal | Low |
| 041 | Feature | Promotional discount codes | Low |
| 045 | Bug | Potential reentrancy vulnerability | Critical |
| 049 | Feature | Meter metadata storage | Low |

## Issues by Priority

### 🔴 Critical (4)
- `006` - Integer overflow in smart contract
- `018` - SQL injection vulnerability
- `044` - Missing webhook signature
- `045` - Reentrancy vulnerability

### 🟡 High (5)
- `002` - MQTT reconnection failure
- `004` - Wallet disconnect race
- `009` - Memory leak in cache
- `027` - Memory exhaustion
- `036` - Allowlist removal missing

### 🟢 Medium (28)
- Frontend: `001`, `008`, `014`, `017`, `020`, `023`, `032`, `038`
- Backend: `005`, `007`, `012`, `015`, `021`, `030`, `031`, `034`, `037`, `039`, `043`, `048`, `050`
- Contracts: `003`, `010`, `013`, `022`, `028`, `033`

### 🔵 Low (13)
- Frontend: `011`, `026`, `029`, `035`, `042`, `046`, `047`
- Contracts: `016`, `025`, `040`, `041`, `049`

## Issues by Type

### Bugs (15)
`002`, `004`, `006`, `009`, `013`, `014`, `018`, `023`, `025`, `027`, `034`, `036`, `038`, `044`, `045`, `048`

### Features (35)
`001`, `003`, `005`, `007`, `008`, `010`, `011`, `012`, `015`, `016`, `017`, `019`, `020`, `021`, `022`, `024`, `026`, `028`, `029`, `030`, `031`, `032`, `033`, `035`, `037`, `039`, `040`, `041`, `042`, `043`, `046`, `047`, `049`, `050`

## Quick Search

- **Security issues**: `006`, `018`, `044`, `045`
- **Performance issues**: `009`, `027`, `034`, `039`, `043`
- **UX improvements**: `001`, `008`, `011`, `017`, `020`, `026`, `029`, `032`, `035`, `042`, `046`, `047`
- **API enhancements**: `005`, `007`, `012`, `021`, `030`, `037`, `050`
- **Payment features**: `001`, `010`, `016`, `020`, `035`, `041`, `047`, `050`
- **Admin tools**: `003`, `016`, `019`, `033`, `040`
- **IoT/MQTT**: `002`, `027`
- **Analytics**: `005`, `039`, `042`

---

For detailed information about each issue, open the corresponding markdown file in this directory.
