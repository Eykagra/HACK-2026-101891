#!/usr/bin/env bash
#
# Provisions a fresh Amazon Linux 2023 instance and starts TaskFlow Pro.
# Idempotent: safe to re-run.
#
#   curl -fsSL https://raw.githubusercontent.com/<owner>/<repo>/submission/deploy/bootstrap-ec2.sh | bash
#
# Instance sizing: t3.micro is enough. The scheduler is O(V+E) and the demo
# board is ten nodes; the memory floor is Node itself, around 60 MB.

set -euo pipefail

REPO_URL="${REPO_URL:-https://github.com/OWNER/REPO.git}"
BRANCH="${BRANCH:-submission}"
APP_DIR="${APP_DIR:-/opt/taskflow-pro}"

log() { printf '\n\033[1;34m==>\033[0m %s\n' "$*"; }

log "Installing Docker and git"
sudo dnf install -y docker git >/dev/null
sudo systemctl enable --now docker
sudo usermod -aG docker "$USER" || true

log "Installing the Docker Compose plugin"
COMPOSE_DIR=/usr/libexec/docker/cli-plugins
sudo mkdir -p "$COMPOSE_DIR"
if [ ! -x "$COMPOSE_DIR/docker-compose" ]; then
  ARCH="$(uname -m)"
  sudo curl -fsSL \
    "https://github.com/docker/compose/releases/latest/download/docker-compose-linux-${ARCH}" \
    -o "$COMPOSE_DIR/docker-compose"
  sudo chmod +x "$COMPOSE_DIR/docker-compose"
fi

log "Fetching the application"
if [ -d "$APP_DIR/.git" ]; then
  sudo git -C "$APP_DIR" fetch --depth 1 origin "$BRANCH"
  sudo git -C "$APP_DIR" reset --hard "origin/$BRANCH"
else
  sudo git clone --depth 1 --branch "$BRANCH" "$REPO_URL" "$APP_DIR"
fi
cd "$APP_DIR"

# Secrets come from SSM Parameter Store when available, so they are never
# committed, never in the shell history, and never in the image.
log "Resolving configuration"
if [ ! -f .env ]; then
  sudo cp .env.example .env
  if command -v aws >/dev/null 2>&1; then
    for name in OPENAI_API_KEY GEMINI_API_KEY ADMIN_TOKEN; do
      value="$(aws ssm get-parameter --name "/taskflow/$name" --with-decryption \
        --query Parameter.Value --output text 2>/dev/null || true)"
      if [ -n "$value" ] && [ "$value" != "None" ]; then
        sudo sed -i "s|^$name=.*|$name=$value|" .env
        echo "  $name loaded from SSM"
      fi
    done
  fi
  # A random admin token is better than a blank one; the reset route is
  # disabled outright when this is empty.
  if ! grep -q '^ADMIN_TOKEN=.\+' .env; then
    sudo sed -i "s|^ADMIN_TOKEN=.*|ADMIN_TOKEN=$(openssl rand -hex 16)|" .env
  fi
fi

log "Building and starting"
sudo docker compose up -d --build

log "Waiting for the health check"
for _ in $(seq 1 30); do
  if sudo docker compose exec -T app node -e \
    "fetch('http://127.0.0.1:8080/api/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))" 2>/dev/null; then
    log "Healthy. Listening on port 80."
    sudo docker compose ps
    exit 0
  fi
  sleep 2
done

log "Did not become healthy in 60s. Recent logs:"
sudo docker compose logs --tail 60 app
exit 1
