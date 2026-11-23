#!/usr/bin/env bash
# One-time VM setup (Debian 12): Node 22, pnpm, a `glade` system user and the systemd unit. Run as root.
set -euo pipefail
apt-get update
apt-get install -y ca-certificates curl
if ! command -v node >/dev/null || ! node -v | grep -q '^v22'; then
  curl -fsSL https://deb.nodesource.com/setup_22.x | bash -
  apt-get install -y nodejs
fi
corepack enable
corepack prepare pnpm@9.15.0 --activate
id glade >/dev/null 2>&1 || useradd --system --create-home --shell /usr/sbin/nologin glade
install -d -o glade -g glade /opt/glade
