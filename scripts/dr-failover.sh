#!/usr/bin/env bash
# #1060: One-click failover — route traffic to the given site (primary|dr).
# Env: DR_SWITCH_CMD — command that repoints DNS / load balancer; receives the site as $1.
#      DR_COMPOSE_HOST — docker context of the DR host (optional, starts the stack there).
set -euo pipefail
SITE="${1:?usage: dr-failover.sh primary|dr}"
case "$SITE" in primary|dr) ;; *) echo "invalid site: $SITE" >&2; exit 2 ;; esac
if [ "$SITE" = dr ] && [ -n "${DR_COMPOSE_HOST:-}" ]; then
  docker --context "$DR_COMPOSE_HOST" compose up -d
fi
if [ -n "${DR_SWITCH_CMD:-}" ]; then
  $DR_SWITCH_CMD "$SITE"
else
  echo "DR_SWITCH_CMD not set — skipping traffic switch (dry run)"
fi
echo "active site: $SITE"
