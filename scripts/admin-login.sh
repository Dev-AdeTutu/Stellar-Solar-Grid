#!/usr/bin/env bash
set -Eeuo pipefail
: "${GRID_API_URL:=http://127.0.0.1:3001}"
read -r -s -p "Admin secret: " ADMIN_SECRET; printf '\n'
read -r -p "Authenticator/recovery code (leave blank if 2FA is disabled): " MFA_CODE
payload=$(printf '%s' "{\"secret\":\"${ADMIN_SECRET//\"/\\\"}\"${MFA_CODE:+,\"code\":\"${MFA_CODE//\"/\\\"}\"}}")
curl --fail-with-body -sS -X POST "${GRID_API_URL}/api/admin/login" -H 'Content-Type: application/json' -d "$payload"
printf '\n'
