#!/usr/bin/env bash
# Deploy the latest commit:  sudo bash /opt/glade/deploy/gcp/update.sh
set -euo pipefail
sudo -u glade bash -c 'cd /opt/glade && git pull --ff-only && pnpm install --frozen-lockfile --filter "@glade/worker..." --filter glade'
install -m 0644 /opt/glade/deploy/gcp/glade-worker.service /etc/systemd/system/glade-worker.service
systemctl daemon-reload
systemctl restart glade-worker
journalctl -u glade-worker -n 20 --no-pager
