#!/bin/sh
# Runtime config injection for the DjinnBot dashboard.
#
# Problem: Vite bakes VITE_API_URL into the JS bundle at build time. Anyone
# using a custom domain/IP must rebuild the entire dashboard image.
#
# Solution: At container startup, generate a tiny config.js from the
# VITE_API_URL environment variable. The app reads window.__RUNTIME_CONFIG__
# first, falling back to the build-time value for dev/local use.
#
# Usage:
#   docker run -e VITE_API_URL=https://djinn.example.com ...
#   No rebuild needed — just restart the container.

set -e

CONFIG_PATH="/usr/share/nginx/html/config.js"

# Generate runtime config from environment variable.
# If VITE_API_URL is empty, write an empty config (app falls back to build-time value).
cat > "$CONFIG_PATH" <<EOF
window.__RUNTIME_CONFIG__ = {
  API_URL: "${VITE_API_URL:-}",
  APP_VERSION: "${DJINNBOT_BUILD_VERSION:-dev}"
};
EOF

echo "Runtime config written: VITE_API_URL=${VITE_API_URL:-<empty, using build-time default>}, VERSION=${DJINNBOT_BUILD_VERSION:-dev}"

# Hand off to nginx
exec nginx -g 'daemon off;'
