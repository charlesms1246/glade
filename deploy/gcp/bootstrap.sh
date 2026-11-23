#!/usr/bin/env bash
# One-time VM setup (Debian 12). Run as root:  sudo bash bootstrap.sh <git-clone-url>
set -euo pipefail
REPO_URL="${1:?usage: bootstrap.sh <git-clone-url>}"

apt-get update
apt-get install -y ca-certificates curl git
curl -fsSL https://deb.nodesource.com/setup_22.x | bash -
apt-get install -y nodejs
corepack enable
corepack prepare pnpm@9.15.0 --activate

id glade >/dev/null 2>&1 || useradd --system --create-home --shell /usr/sbin/nologin glade
if [ ! -d /opt/glade/.git ]; then git clone "$REPO_URL" /opt/glade; fi
chown -R glade:glade /opt/glade
sudo -u glade bash -c 'cd /opt/glade && pnpm install --frozen-lockfile --filter "@glade/worker..." --filter glade'
chmod 0755 /opt/glade/deploy/gcp/*.sh

install -m 0644 /opt/glade/deploy/gcp/glade-worker.service /etc/systemd/system/glade-worker.service
systemctl daemon-reload
systemctl enable --now glade-worker
systemctl --no-pager status glade-worker | head -5
