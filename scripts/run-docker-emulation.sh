#!/usr/bin/env bash
set -euo pipefail

compose=(docker compose -f docker-compose.emulation.yml)
cleanup() { "${compose[@]}" down --volumes --remove-orphans >/dev/null 2>&1 || true; }
trap cleanup EXIT

cleanup
certs=.artifacts/emulation-certs
rm -rf "$certs"
mkdir -p "$certs"
openssl req -x509 -newkey rsa:2048 -nodes -days 1 \
  -subj '/CN=emulator' -addext 'subjectAltName=DNS:emulator' \
  -keyout "$certs/emulator.key" -out "$certs/emulator.crt" >/dev/null 2>&1

"${compose[@]}" up --build --detach
for _ in {1..60}; do
  if result="$(curl --silent --show-error --fail --insecure https://127.0.0.1:18443/acceptance 2>/dev/null)"; then
    if RESULT="$result" node -e 'const r=JSON.parse(process.env.RESULT); if(!r.ok) process.exit(1)'; then
      printf '%s\n' "$result"
      exit 0
    fi
  fi
  sleep 1
done

"${compose[@]}" logs --no-color
echo 'Docker emulation did not complete within 60 seconds.' >&2
exit 1
