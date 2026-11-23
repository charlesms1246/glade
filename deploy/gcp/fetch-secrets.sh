#!/usr/bin/env bash
# Pulls the worker's secrets from Secret Manager into /etc/glade (root-owned dir, files readable only by glade).
set -euo pipefail
install -d -m 0750 -o root -g glade /etc/glade
umask 077
gcloud secrets versions access latest --secret=glade-env >/etc/glade/env.tmp
gcloud secrets versions access latest --secret=glade-org-key >/etc/glade/org-key.json.tmp
mv /etc/glade/env.tmp /etc/glade/env
mv /etc/glade/org-key.json.tmp /etc/glade/org-key.json
chown root:glade /etc/glade/env /etc/glade/org-key.json
chmod 0640 /etc/glade/env /etc/glade/org-key.json
