#!/usr/bin/env bash
# Explicit installation only. No model requests or GitHub writes. The timer's
# Cursor account sampler performs read-only Dashboard requests with existing auth.
set -euo pipefail
usage_root="$(cd "$(dirname "$0")/.." && pwd)"
if [[ "${EUID}" -ne 0 ]]; then
  echo 'Run with sudo bash scripts/install-execution-usage.sh' >&2
  exit 1
fi
if [[ "$usage_root" != '/srv/projects/windsurf-dao' ]]; then
  echo 'Install from the integrated /srv/projects/windsurf-dao checkout.' >&2
  exit 1
fi
id orca >/dev/null
install -d -o orca -g orca -m 700 /home/orca/.dao/execution/usage
# Root execution is confined to an installed copy in a root-owned parent. The
# shared inbox is root-owned/orca-readable; /root permissions are never changed.
install -d -o root -g root -m 755 /usr/local/lib/dao-execution-usage /usr/local/lib/dao-execution-usage/lib /var/lib/dao-execution-usage
install -d -o root -g root -m 700 /var/lib/dao-execution-usage/private
install -d -o root -g orca -m 750 /var/lib/dao-execution-usage/root-inbox
install -o root -g root -m 644 "$usage_root/scripts/execution-usage-export.mjs" /usr/local/lib/dao-execution-usage/execution-usage-export.mjs
install -o root -g root -m 644 "$usage_root/scripts/lib/execution-usage.mjs" /usr/local/lib/dao-execution-usage/lib/execution-usage.mjs
# env -i scrubs inherited provider/GitHub credentials and root HOME. No auth is
# needed for a read-only report. Unknown/empty data (2) is expected before smoke.
usage_probe=0
runuser -u orca -- env -i HOME=/home/orca USER=orca LOGNAME=orca \
  PATH=/usr/local/bin:/usr/bin:/bin GH_CONFIG_DIR=/var/empty \
  /usr/bin/node "$usage_root/scripts/execution-usage.mjs" --json >/dev/null || usage_probe=$?
if [[ "$usage_probe" -ne 0 && "$usage_probe" -ne 2 ]]; then
  echo 'Collector report preflight failed; no units installed.' >&2
  exit 1
fi
install -m 644 "$usage_root/host/machine/systemd/dao-execution-usage.service" /etc/systemd/system/dao-execution-usage.service
install -m 644 "$usage_root/host/machine/systemd/dao-execution-usage-export.service" /etc/systemd/system/dao-execution-usage-export.service
install -m 644 "$usage_root/host/machine/systemd/dao-execution-usage.timer" /etc/systemd/system/dao-execution-usage.timer
systemctl daemon-reload
systemctl enable --now dao-execution-usage.timer
usage_next="$(systemctl show dao-execution-usage.timer -p NextElapseUSecRealtime --value)"
case "$usage_next" in
  ''|0|n/a|infinity) echo 'dao-execution-usage.timer has no next trigger.' >&2; exit 1 ;;
esac
echo 'Installed dao-execution-usage.timer with a scheduled next trigger.'
