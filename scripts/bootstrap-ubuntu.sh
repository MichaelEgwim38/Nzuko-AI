#!/usr/bin/env bash
set -euo pipefail

echo "== Nzuko AI Ubuntu bootstrap =="
echo "This installs Docker, Docker Compose, Git, and opens ports 80/443."

sudo apt-get update
sudo apt-get install -y ca-certificates curl git ufw

if ! command -v docker >/dev/null 2>&1; then
  curl -fsSL https://get.docker.com | sudo sh
fi

sudo usermod -aG docker "$USER" || true

sudo ufw allow OpenSSH
sudo ufw allow 80/tcp
sudo ufw allow 443/tcp
sudo ufw --force enable

docker --version
docker compose version

echo "Bootstrap complete. Log out and back in if Docker says permission denied."
