# Stellar SolarGrid - GitHub Issues Collection

This directory contains 50 unique, ready-to-submit GitHub issues for the Stellar SolarGrid project. Each issue follows the project's issue template guidelines and covers various aspects of the platform.

## Issue Breakdown by Category

### 🐛 Bug Reports (15 issues)
- **Frontend Bugs**: 4 issues
  - `004` - Wallet disconnect race condition
  - `014` - Usage chart timezone display
  - `023` - Payment history pagination
  - `038` - Balance display rounding errors

- **Backend Bugs**: 7 issues
  - `002` - MQTT reconnection failure
  - `009` - Idempotency cache memory leak
  - `018` - SQL injection vulnerability in meter notes
  - `027` - Memory exhaustion with large batches
  - `034` - Prometheus metric race conditions
  - `044` - Missing webhook signature verification
  - `048` - Environment validation timing issue

- **Contract Bugs**: 4 issues
  - `006` - Integer overflow in balance calculations
  - `013` - Missing payment plan change events
  - `025` - Timestamp comparison issues (DST)
  - `036` - Missing allowlist removal function
  - `045` - Potential reentrancy vulnerability

### ✨ Feature Requests (35 issues)

#### Frontend Features (12)
- `001` - Payment history CSV export
- `008` - Dark mode theme
- `011` - French and Swahili translations
- `017` - Browser push notifications
- `020` - QR code payment generation
- `026` - Offline mode with service worker
- `029` - Custom meter nicknames
- `032` - Accessibility improvements (keyboard navigation)
- `035` - Downloadable payment receipts
- `042` - Usage forecasting
- `046` - Side-by-side meter comparison
- `047` - Quick payment amount presets

#### Backend Features (13)
- `005` - Usage analytics and trends endpoint
- `007` - GraphQL API
- `012` - Per-user rate limiting
- `015` - Exponential backoff for webhooks
- `021` - Detailed health check endpoint
- `024` - Configurable CORS origins
- `030` - API versioning strategy
- `031` - Structured JSON logging
- `037` - Request/response logging middleware
- `039` - Usage event compression
- `043` - Multiple RPC endpoints with failover
- `050` - Payment webhook notifications

#### Smart Contract Features (10)
- `003` - Bulk meter deactivation
- `010` - Monthly subscription plans
- `016` - Payment refund function
- `019` - Emergency pause mechanism
- `022` - Meter ownership transfer
- `028` - Grace period before deactivation
- `033` - Batch meter registration
- `040` - Emergency admin fund withdrawal
- `041` - Promotional discount codes
- `049` - Meter metadata storage

## Issue Categories by Component

### Frontend (React/TypeScript): 16 issues
`001`, `004`, `008`, `011`, `014`, `017`, `020`, `023`, `026`, `029`, `032`, `035`, `038`, `042`, `046`, `047`

### Backend (Node.js/Express/IoT): 20 issues
`002`, `005`, `007`, `009`, `012`, `015`, `018`, `021`, `024`, `027`, `030`, `031`, `034`, `037`, `039`, `043`, `044`, `048`, `050`

### Smart Contracts (Soroban/Rust): 14 issues
`003`, `006`, `010`, `013`, `016`, `019`, `022`, `025`, `028`, `033`, `036`, `040`, `041`, `045`, `049`

## Priority Recommendations

### 🔴 Critical (Security & Data Integrity)
- `018` - SQL injection vulnerability
- `044` - Missing webhook signature
- `045` - Reentrancy vulnerability
- `006` - Integer overflow risks

### 🟡 High Priority (UX & Stability)
- `002` - MQTT reconnection
- `004` - Wallet disconnect race
- `009` - Memory leak in cache
- `027` - Memory exhaustion
- `036` - Allowlist removal missing

### 🟢 Medium Priority (Features & Enhancements)
- `007` - GraphQL API
- `008` - Dark mode
- `019` - Emergency pause
- `032` - Accessibility improvements
- `039` - Usage compression

### 🔵 Nice to Have
- `011` - Multi-language support
- `041` - Discount codes
- `046` - Meter comparison
- `047` - Payment presets

## How to Use These Issues

1. **Review each issue** - Read through and adjust details as needed
2. **Create on GitHub** - Copy content to GitHub issue creation form
3. **Add labels** - Apply appropriate labels (bug, enhancement, security, etc.)
4. **Assign milestones** - Group related issues into development sprints
5. **Prioritize** - Use the priority recommendations above as a starting point

## Issue Template Compliance

All issues follow the project's official templates:
- ✅ Bug reports use `.github/ISSUE_TEMPLATE/bug_report.md` format
- ✅ Feature requests use `.github/ISSUE_TEMPLATE/feature_request.md` format
- ✅ All required sections filled out
- ✅ Environment information included where applicable
- ✅ Affected components clearly marked

## Contributing

These issues are ready for:
- Community discussion and refinement
- Assignment to contributors
- Integration into project roadmap
- Estimation and sprint planning

---

**Generated**: August 25, 2026
**Total Issues**: 50
**Bug Reports**: 15
**Feature Requests**: 35
