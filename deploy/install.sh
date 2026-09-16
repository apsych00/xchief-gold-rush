#!/usr/bin/env bash
# deploy/install.sh - one-time setup of a fresh Ubuntu 24.04 box. Run once as
# root. Idempotent: safe to re-run after fixing whatever it stopped on (a
# missing deploy key, an unfilled .env.box).
set -euo pipefail

REPO_DIR="${REPO_DIR:-/opt/goldrush}"
REPO_URL="${REPO_URL:-git@github.com:AIT-ERP/xChief-Gold-Rush.git}"
DEPLOY_USER="${DEPLOY_USER:-deploy}"
DEPLOY_BRANCH="${DEPLOY_BRANCH:-dev}"

if [ "$(id -u)" -ne 0 ]; then
  echo "install.sh must run as root" >&2
  exit 1
fi

echo "==> Docker (official install script, from Docker's own repo)"
if ! command -v docker >/dev/null 2>&1; then
  curl -fsSL https://get.docker.com | sh
else
  echo "docker already installed, skipping"
fi

echo "==> deploy user"
if ! id -u "$DEPLOY_USER" >/dev/null 2>&1; then
  adduser --disabled-password --gecos "" "$DEPLOY_USER"
fi
usermod -aG docker "$DEPLOY_USER"

echo "==> read-only deploy key"
deploy_key="/home/$DEPLOY_USER/.ssh/id_ed25519"
if [ ! -f "$deploy_key" ]; then
  cat <<KEYHELP
No deploy key found at $deploy_key.

This script does not generate one - a read-only key must be issued to this
box on purpose, not minted by an install script:

  1. On your own machine:   ssh-keygen -t ed25519 -f goldrush-deploy -N ""
  2. GitHub repo -> Settings -> Deploy keys -> Add deploy key: paste
     goldrush-deploy.pub, leave "Allow write access" UNCHECKED.
  3. Copy the private half to this box, owned by $DEPLOY_USER, mode 600:
       scp goldrush-deploy root@<box-ip>:$deploy_key
       chown $DEPLOY_USER:$DEPLOY_USER $deploy_key
       chmod 600 $deploy_key
  4. Re-run install.sh.
KEYHELP
  exit 1
fi
chown "$DEPLOY_USER:$DEPLOY_USER" "$deploy_key"
chmod 600 "$deploy_key"

ssh_config="/home/$DEPLOY_USER/.ssh/config"
if [ ! -f "$ssh_config" ]; then
  cat > "$ssh_config" <<SSHCONFIG
Host github.com
  HostName github.com
  User git
  IdentityFile $deploy_key
  IdentitiesOnly yes
SSHCONFIG
  chown "$DEPLOY_USER:$DEPLOY_USER" "$ssh_config"
  chmod 600 "$ssh_config"
fi

echo "==> clone"
if [ ! -d "$REPO_DIR/.git" ]; then
  mkdir -p "$(dirname "$REPO_DIR")"
  sudo -u "$DEPLOY_USER" git clone --branch "$DEPLOY_BRANCH" "$REPO_URL" "$REPO_DIR"
else
  echo "$REPO_DIR already a git checkout, skipping clone"
fi
chown -R "$DEPLOY_USER:$DEPLOY_USER" "$REPO_DIR"

echo "==> box env"
cd "$REPO_DIR"
if [ ! -f .env.box ]; then
  cp .env.box.example .env.box
  chown "$DEPLOY_USER:$DEPLOY_USER" .env.box
  chmod 600 .env.box
  cat <<ENVHELP

Stopping here: .env.box was just created from .env.box.example and every
value in it is blank. Fill it in as $DEPLOY_USER (see docs/box-deploy.md
section 4: POSTGRES_PASSWORD, DATABASE_URL, SITE_ADDRESS, FINNHUB_TOKEN,
PLAYER_TOKEN_SECRET, ELASTIC_API_KEY, OTP_SENDER, DOZZLE_PASSWORD_HASH), then
re-run install.sh, or run deploy/deploy.sh directly once it is filled in.
ENVHELP
  exit 1
else
  echo ".env.box already exists, skipping"
fi

echo "==> cron: autodeploy every minute"
cron_file="/etc/cron.d/goldrush-autodeploy"
cron_line="* * * * * $DEPLOY_USER cd $REPO_DIR && ./deploy/autodeploy.sh"
if [ ! -f "$cron_file" ] || ! grep -qF "autodeploy.sh" "$cron_file"; then
  echo "$cron_line" > "$cron_file"
  chmod 644 "$cron_file"
else
  echo "cron entry already present, skipping"
fi

echo "==> firewall: 22, 80, 443 only"
if command -v ufw >/dev/null 2>&1; then
  ufw allow 22/tcp
  ufw allow 80/tcp
  ufw allow 443/tcp
  ufw --force enable
else
  echo "ufw not found on this image - install it and restrict the firewall by hand" >&2
fi

cat <<DONE

install.sh done.

- restart: unless-stopped is set on every service in docker-compose.yml
  already, so a crash or reboot self-heals once the stack is up; nothing
  further to enable for that.
- Postgres (5432), the game server (8787) and Dozzle are never published by
  compose - only Caddy's 80/443 are, matching the ufw rules just set.

Next: as $DEPLOY_USER, run deploy/deploy.sh to build and start the box for
the first time.
DONE
