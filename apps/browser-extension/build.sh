#!/usr/bin/env bash
# Build DjinnBot Cookie Bridge extension for Chrome and Firefox.
#
# Produces:
#   dist/chrome/   — ready to load as unpacked extension or zip for Chrome Web Store
#   dist/firefox/  — ready to load as temporary addon or zip for AMO
#
# Usage:
#   ./build.sh          # build both
#   ./build.sh chrome   # build chrome only
#   ./build.sh firefox  # build firefox only

set -euo pipefail
cd "$(dirname "$0")"

SHARED_FILES=(
  "src/background.js"
  "src/popup.html"
  "src/popup.js"
)

build_variant() {
  local target="$1"
  local dist="dist/${target}"

  echo "Building ${target}..."
  rm -rf "$dist"
  mkdir -p "$dist/icons"

  # Copy shared source files
  for f in "${SHARED_FILES[@]}"; do
    cp "$f" "$dist/$(basename "$f")"
  done

  # Copy manifest
  cp "src/manifest.${target}.json" "$dist/manifest.json"

  # Copy icons (generate placeholder SVGs if PNGs don't exist yet)
  if [ -f "icons/icon-16.png" ]; then
    cp icons/icon-*.png "$dist/icons/"
  else
    echo "Warning: icons not found, generating placeholders..."
    for size in 16 48 128; do
      # Create a simple 1x1 magenta PNG as placeholder
      printf '\x89PNG\r\n\x1a\n\x00\x00\x00\rIHDR\x00\x00\x00\x01\x00\x00\x00\x01\x08\x02\x00\x00\x00\x90wS\xde\x00\x00\x00\x0cIDATx\x9cc\xf8\x0f\x00\x00\x01\x01\x00\x05\x18\xd8N\x00\x00\x00\x00IEND\xaeB`\x82' > "$dist/icons/icon-${size}.png"
    done
  fi

  # Create zip for store submission
  (cd "$dist" && zip -qr "../djinnbot-cookie-bridge-${target}.zip" .)

  echo "  -> dist/${target}/ (unpacked)"
  echo "  -> dist/djinnbot-cookie-bridge-${target}.zip"
}

case "${1:-all}" in
  chrome)  build_variant chrome ;;
  firefox) build_variant firefox ;;
  all)
    build_variant chrome
    build_variant firefox
    ;;
  *)
    echo "Usage: $0 [chrome|firefox|all]"
    exit 1
    ;;
esac

echo "Done."
