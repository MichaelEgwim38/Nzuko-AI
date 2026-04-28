#!/usr/bin/env bash
set -euo pipefail

if [ ! -f ".env.host" ]; then
  echo "Missing .env.host. Copy .env.host.example to .env.host and fill secrets first."
  exit 1
fi

mkdir -p data sessions
docker compose --env-file .env.host up -d --build
docker compose --env-file .env.host ps

echo "Nzuko AI deploy command finished."
