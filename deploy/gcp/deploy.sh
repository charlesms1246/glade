#!/usr/bin/env bash
# Ship the committed HEAD to the VM and restart the worker. Run from the repo root on your machine:
#   GCP_PROJECT=... GCP_ZONE=... bash deploy/gcp/deploy.sh
set -euo pipefail
: "${GCP_PROJECT:?set GCP_PROJECT}" "${GCP_ZONE:?set GCP_ZONE}"
VM="${GCP_VM:-glade-worker}"
REV="$(git rev-parse --short HEAD)"
TAR="$(mktemp -t glade-XXXX).tar.gz"
git archive --format=tar.gz -o "$TAR" HEAD
gcloud compute scp "$TAR" "$VM:/tmp/glade.tar.gz" --project="$GCP_PROJECT" --zone="$GCP_ZONE"
rm -f "$TAR"
gcloud compute ssh "$VM" --project="$GCP_PROJECT" --zone="$GCP_ZONE" -- "sudo bash -s" <<REMOTE
set -euo pipefail
find /opt/glade -mindepth 1 -maxdepth 1 ! -name node_modules -exec rm -rf {} +
tar -xzf /tmp/glade.tar.gz -C /opt/glade && rm /tmp/glade.tar.gz
echo "$REV" > /opt/glade/REVISION
chown -R glade:glade /opt/glade
chmod 0755 /opt/glade/deploy/gcp/*.sh
sudo -u glade bash -c 'cd /opt/glade && CI=1 pnpm install --frozen-lockfile --filter "@glade/worker..." --filter glade'
install -m 0644 /opt/glade/deploy/gcp/glade-worker.service /etc/systemd/system/glade-worker.service
systemctl daemon-reload
systemctl enable glade-worker >/dev/null 2>&1
systemctl restart glade-worker
sleep 8
systemctl --no-pager --lines=0 status glade-worker | head -3
journalctl -u glade-worker -n 8 --no-pager -o cat
REMOTE
echo "deployed $REV"
