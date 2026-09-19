#!/usr/bin/env bash
# 幂等安装 DAO fleet 的两只常驻单元（Temporal 服务端 + worker）。要 root：
#   bash scripts/install-fleet.sh
#
# 装什么：
#   /usr/local/bin/temporal                固定版本 CLI（校验 sha256 后才装）
#   /etc/systemd/system/dao-fleet-temporal.service
#   /etc/systemd/system/dao-fleet-worker.service
#   packages/fleet/node_modules            按 package-lock 安装（npm ci）
#
# 不装什么：不碰 mirasim-server / 指挥官 / 旧的派工入口。新链路与旧链路可以并存，
# 切换入口是另一件事（见 #816）。
#
# 为什么钉版本 + 校验和：Temporal CLI 是外部二进制，装到机器上就等于进了信任面。
# 「latest」会在某天悄悄换掉跑在机器上的东西，而且没有任何东西会告诉你。
set -euo pipefail

TEMPORAL_VERSION="1.8.3"
TEMPORAL_SHA256_LINUX_AMD64="6f0afac1e9ddea71f480c43a49f5db5167a244c21db923707f069a79bcabdfea"
TEMPORAL_URL="https://github.com/temporalio/cli/releases/download/v${TEMPORAL_VERSION}/temporal_cli_${TEMPORAL_VERSION}_linux_amd64.tar.gz"

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
UNIT_DIR="$ROOT/host/machine/systemd"

if [[ "${EUID}" -ne 0 ]]; then
  echo "要 root：sudo bash $0" >&2
  exit 1
fi
for f in "$UNIT_DIR/dao-fleet-temporal.service" "$UNIT_DIR/dao-fleet-worker.service" "$ROOT/packages/fleet/package.json" "$ROOT/packages/fleet/package-lock.json"; do
  [[ -f "$f" ]] || { echo "装机源不在：$f" >&2; exit 1; }
done

# ── 0. 先撤同名 transient 单元 ──
# 早期用 systemd-run 起的 transient 单元会遮住同名文件单元（daemon-reload 也不会换掉它），
# 而且重启机器就没了。发现就停掉，让下面的文件单元接管。
for unit in dao-fleet-temporal.service dao-fleet-worker.service; do
  if [[ "$(systemctl show "$unit" -p FragmentPath --value 2>/dev/null)" == /run/systemd/transient/* ]]; then
    echo "撤 transient 单元：$unit"
    systemctl stop "$unit" || true
  fi
done

# ── 1. Temporal CLI：版本对且校验和对就跳过，否则重装 ──
need_temporal=1
if [[ -x /usr/local/bin/temporal ]]; then
  have="$(/usr/local/bin/temporal --version 2>/dev/null | sed -n 's/^temporal version \([0-9.]*\).*/\1/p' | head -1)"
  [[ "$have" == "$TEMPORAL_VERSION" ]] && need_temporal=0
fi
if [[ "$need_temporal" == 1 ]]; then
  tmp="$(mktemp -d)"
  trap 'rm -rf "$tmp"' EXIT
  echo "下载 Temporal CLI ${TEMPORAL_VERSION}…"
  curl -fsSL -o "$tmp/temporal.tar.gz" "$TEMPORAL_URL"
  echo "${TEMPORAL_SHA256_LINUX_AMD64}  $tmp/temporal.tar.gz" | sha256sum -c -
  tar -xzf "$tmp/temporal.tar.gz" -C "$tmp"
  install -m 755 "$tmp/temporal" /usr/local/bin/temporal
fi
echo "✓ temporal $(/usr/local/bin/temporal --version | head -1)"

# ── 2. 依赖：按 lock 装，不按 semver 浮动 ──
if [[ ! -d "$ROOT/packages/fleet/node_modules" ]]; then
  echo "安装 packages/fleet 依赖（npm ci）…"
  ( cd "$ROOT/packages/fleet" && runuser -u orca -- npm ci --no-audit --no-fund )
fi
echo "✓ packages/fleet/node_modules 就位"

# ── 3. 单元：装 + reload + enable --now + 验 NEXT/ACTIVE ──
install -m 644 "$UNIT_DIR/dao-fleet-temporal.service" /etc/systemd/system/dao-fleet-temporal.service
install -m 644 "$UNIT_DIR/dao-fleet-worker.service" /etc/systemd/system/dao-fleet-worker.service
install -d -o orca -g orca -m 700 /home/orca/.dao/temporal
systemctl daemon-reload
systemctl enable --now dao-fleet-temporal.service
systemctl enable --now dao-fleet-worker.service

# 装完必须读回来：光 enable 不等于在跑（这个仓被「装上了但没跑」咬过很多次）
for unit in dao-fleet-temporal.service dao-fleet-worker.service; do
  for i in $(seq 1 20); do
    state="$(systemctl is-active "$unit" || true)"
    [[ "$state" == "active" ]] && break
    sleep 0.5
  done
  if [[ "$state" != "active" ]]; then
    echo "启动失败：$unit（is-active=$state）——journalctl -u $unit -n 50 看现场" >&2
    exit 1
  fi
  echo "✓ $unit active"
done

# worker 起得来不代表连得上服务端：让它自己说一句（journal 里应有 worker 已启动）
sleep 2
if ! journalctl -u dao-fleet-worker.service --since "-1min" --no-pager -o cat 2>/dev/null | grep -q "worker 已启动"; then
  echo "worker 起来了但没打出启动行——journalctl -u dao-fleet-worker -n 50 看现场" >&2
  exit 1
fi
echo "✓ fleet 装机完成：temporal 127.0.0.1:7233 + worker（queue dao-fleet）"
echo "  起一个任务：cd $ROOT/packages/fleet && node src/cli.mjs start --repo <owner/name> --issue <N> --lead-profile <p> --executor-profile <p> --reviewer-profile <p>"
