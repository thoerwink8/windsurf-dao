#!/usr/bin/env bash
# scripts/vnc-browser.sh —— 服务器上起一个「你能亲手操作」的浏览器（#1006 建 App 时需要）
#
# 为什么要它：有些事没有 API，只能在浏览器里以账号所有者身份点——建 GitHub App 就是
# （GitHub 没有 POST /apps，PAT 权限再大也建不出来）。无头浏览器过不了这一关，
# 因为登录要人输密码和 2FA。
#
# 做法：服务器上起一块虚拟屏（Xvfb）+ 窗口管理器（openbox）+ 浏览器，再用 x11vnc 把这块屏
# 通过 **只监听 127.0.0.1** 的端口暴露出来。人从自己电脑开 SSH 隧道连进来，
# 亲手输账号密码；登录态落在 profile 目录里，之后脚本复用同一个 profile 就是已登录状态。
#
# 密码和 2FA 全程只经过用户自己的键盘和这块屏，不进任何日志、不进 AI 的上下文。
#
# 用法（都以 orca 身份跑，root 跑会在 orca 家里留 root 属主文件——判例 root-owned-files-in-service-home）：
#   scripts/vnc-browser.sh start [URL]   起屏 + 浏览器，打印 SSH 隧道命令
#   scripts/vnc-browser.sh status        看还活着没
#   scripts/vnc-browser.sh stop          全停（用完就停，别让它常驻）
#
# 刻意不做成 systemd 常驻服务：一块随时可连的远程桌面是长期攻击面，
# 而它一年也用不了几次。要用现起，用完停掉。
set -uo pipefail

DISPLAY_NUM="${VNC_DISPLAY:-:99}"
VNC_PORT="${VNC_PORT:-5900}"
WEB_PORT="${VNC_WEB_PORT:-6080}"
# 网页入口的域名：sslip.io 把 IP 编进域名直接解析，不用买域名也不用配 DNS。
# 别换成 nip.io / duckdns.org——那两个的 SNI 被整域阻断（判例 memory sni-blocklist-nipio-duckdns）。
WEB_HOST="${VNC_WEB_HOST:-13-140-184-255.sslip.io}"
CERT_LIVE="/etc/letsencrypt/live/$WEB_HOST"
GEOMETRY="${VNC_GEOMETRY:-1600x900x24}"
DAO_HOME="${DAO_HOME:-$HOME/.dao}"
VNC_DIR="$DAO_HOME/vnc"
PASSWD_FILE="$VNC_DIR/passwd"
PROFILE_DIR="$DAO_HOME/browser-profile"
BROWSERS_PATH="${PLAYWRIGHT_BROWSERS_PATH:-/opt/ms-playwright}"

die() { echo "vnc-browser: $*" >&2; exit 1; }

chromium_bin() {
  # playwright 的 chromium（不是 headless_shell——那个没有窗口，起不来界面）
  # 目录名两种都认：老版是 chrome-linux，playwright 1.6x 起改成 chrome-linux64。
  # 别写死一种：写死哪种，另一种就报「找不到浏览器」而真因是版本差异。
  local c
  c=$(ls -d "$BROWSERS_PATH"/chromium-*/chrome-linux*/chrome 2>/dev/null | head -1)
  [ -n "$c" ] || die "找不到 chromium：$BROWSERS_PATH 下没有 chromium-*/chrome-linux/chrome。
先按 NEW-MACHINE §13b 装：PLAYWRIGHT_BROWSERS_PATH=/opt/ms-playwright playwright install --with-deps chromium"
  echo "$c"
}

# 网页入口：Windows 上直接开链接就能操作，不用装 VNC 客户端、不用开 SSH 隧道。
#
# 为什么坚持要真证书（Let's Encrypt + sslip.io），不肯用自签让人点「继续」：
# 这块屏的用途就是让人在里面输 GitHub 密码和 2FA。自签 + 点继续 = 训练自己忽略证书警告，
# 而那正是中间人攻击唯一需要的东西。域名不用买：sslip.io 把 IP 编进域名直接解析。
#
# 端口只在会话期间开，stop 时关掉——一个常开的远程桌面端口是长期攻击面。
web_start() {
  # 这一段要 root（读 letsencrypt 私钥、绑端口、改 ufw），而 **不能** 给 orca 补 sudo：
  # 每个工人 agent 都能写这个仓，放宽 sudo 等于给所有工人一条提权路
  # （同样的道理写在 host/machine/sudoers.d/dao-sync 里，那条规则也是命令写死不带通配）。
  # 所以：X + 浏览器归 orca，网页桥归 root，两段各跑各的。
  if [ "$(id -u)" != "0" ]; then
    echo "网页入口要 root 起（不给 orca 补 sudo，理由见本函数注释）。另开一条：
  sudo bash $0 web-start" >&2
    return 0
  fi
  [ -r "$CERT_LIVE/fullchain.pem" ] || { echo "没有 $WEB_HOST 的证书，跳过网页入口（只留本地 VNC）。
补：ufw allow 80/tcp && certbot certonly --standalone -d $WEB_HOST && ufw delete allow 80/tcp" >&2; return 0; }
  [ -r /usr/share/novnc/vnc.html ] || { echo "没装 novnc，跳过网页入口：apt install novnc websockify" >&2; return 0; }

  # 每次 start 都重新拼 pem：certbot 自动续期后 live/ 会换内容，
  # 只在第一次拼就会在续期后拿着过期证书起服务（而浏览器只会说「证书无效」，不会说「你该重拼了」）。
  local pem="$VNC_DIR/novnc.pem"
  cat "$CERT_LIVE/fullchain.pem" "$CERT_LIVE/privkey.pem" > "$pem" 2>/dev/null || {
    echo "拼证书失败（多半是没权限读 $CERT_LIVE，需要 root 或把 privkey 授权给本用户）" >&2; return 0; }
  chmod 600 "$pem"

  pgrep -f "websockify.*$WEB_PORT" >/dev/null 2>&1 \
    || websockify --daemon --web /usr/share/novnc --cert "$pem" \
         "$WEB_PORT" "127.0.0.1:$VNC_PORT" >>"$VNC_DIR/websockify.log" 2>&1

  command -v ufw >/dev/null 2>&1 && ufw allow "$WEB_PORT/tcp" >/dev/null 2>&1
}

web_stop() {
  pkill -f "websockify.*$WEB_PORT" 2>/dev/null
  command -v ufw >/dev/null 2>&1 && ufw delete allow "$WEB_PORT/tcp" >/dev/null 2>&1
}

start() {
  local url="${1:-https://github.com/settings/apps}"
  [ "$(id -un)" = "root" ] && die "别用 root 跑：会在服务用户家里留 root 属主文件。改用 sudo -u orca -H $0 start"

  mkdir -p "$VNC_DIR" "$PROFILE_DIR" || die "建目录失败"
  chmod 700 "$VNC_DIR"

  if [ ! -f "$PASSWD_FILE" ]; then
    # 随机密码，只落在 600 的文件里；x11vnc 自己加密存储
    local pw
    pw=$(head -c 9 /dev/urandom | base64 | tr -d '/+=' | cut -c1-8)
    x11vnc -storepasswd "$pw" "$PASSWD_FILE" >/dev/null 2>&1 || die "存密码失败"
    chmod 600 "$PASSWD_FILE"
    echo "本次 VNC 密码（只显示这一次，存在 $PASSWD_FILE）：$pw"
  else
    echo "沿用已有密码：$PASSWD_FILE（要换就删掉它再 start）"
  fi

  pgrep -f "Xvfb $DISPLAY_NUM" >/dev/null 2>&1 \
    || { Xvfb "$DISPLAY_NUM" -screen 0 "$GEOMETRY" >/dev/null 2>&1 & sleep 1; }
  pgrep -f "openbox" >/dev/null 2>&1 \
    || { DISPLAY="$DISPLAY_NUM" openbox >/dev/null 2>&1 & sleep 1; }

  # -localhost 是这条路安全性的全部依赖：不加它就是把桌面挂到公网上
  pgrep -f "x11vnc.*$DISPLAY_NUM" >/dev/null 2>&1 \
    || x11vnc -display "$DISPLAY_NUM" -localhost -rfbauth "$PASSWD_FILE" \
         -rfbport "$VNC_PORT" -forever -shared -noxdamage -bg -q >/dev/null 2>&1

  local chrome; chrome=$(chromium_bin) || exit 1
  # 日志不许丢：第一次跑就是 chromium 崩了而 stderr 进了 /dev/null，
  # 面上只看到「浏览器那一格是停的」，查不出为什么（Ubuntu 24.04 的
  # kernel.apparmor_restrict_unprivileged_userns=1 挡了沙箱，解法见 /etc/apparmor.d/playwright-chromium）。
  local log="$VNC_DIR/chrome.log"
  pgrep -f "user-data-dir=$PROFILE_DIR" >/dev/null 2>&1 \
    || { DISPLAY="$DISPLAY_NUM" "$chrome" \
           --user-data-dir="$PROFILE_DIR" \
           --no-first-run --no-default-browser-check \
           --disable-dev-shm-usage \
           "$url" >>"$log" 2>&1 & sleep 4; }
  if ! pgrep -f "user-data-dir=$PROFILE_DIR" >/dev/null 2>&1; then
    echo "浏览器起来又退了。最后几行（$log）：" >&2
    tail -5 "$log" >&2
  fi

  web_start

  status
  cat <<TUNNEL

怎么连——两条路，任选：

  【网页，推荐】Windows 上直接开这个链接，输上面的密码即可：
      https://$WEB_HOST:$WEB_PORT/vnc.html?autoconnect=1&resize=scale
      真证书（Let's Encrypt），不会弹「不安全」；不用装客户端、不用开隧道。

  【SSH 隧道，端口不对外时用】在你本机跑：
      ssh -N -L $VNC_PORT:127.0.0.1:$VNC_PORT <你连这台服务器用的 ssh 目标>
      再用任意 VNC 客户端连 127.0.0.1:$VNC_PORT。

浏览器已经开在 $url。登录你自己输，我看不到。

登录态落在 $PROFILE_DIR，之后脚本带 --user-data-dir 指这里就是已登录状态。
用完记得：$0 stop
TUNNEL
}

status() {
  local ok=0
  for pat in "Xvfb $DISPLAY_NUM" "openbox" "x11vnc.*$DISPLAY_NUM" "user-data-dir=$PROFILE_DIR"; do
    if pgrep -f "$pat" >/dev/null 2>&1; then echo "  活  $pat"; else echo "  停  $pat"; ok=1; fi
  done
  ss -tln 2>/dev/null | grep -q "127.0.0.1:$VNC_PORT" \
    && echo "  活  VNC 只听 127.0.0.1:$VNC_PORT（对公网不可见）" \
    || echo "  停  VNC 端口 $VNC_PORT 没在听"
  if pgrep -f "websockify.*$WEB_PORT" >/dev/null 2>&1; then
    echo "  活  网页入口 https://$WEB_HOST:$WEB_PORT/vnc.html"
  else
    echo "  停  网页入口（没起 websockify）"
  fi
  return $ok
}

stop() {
  web_stop
  pkill -f "user-data-dir=$PROFILE_DIR" 2>/dev/null
  pkill -f "x11vnc.*$DISPLAY_NUM" 2>/dev/null
  pkill -f "openbox" 2>/dev/null
  pkill -f "Xvfb $DISPLAY_NUM" 2>/dev/null
  sleep 1
  echo "已停。profile 保留在 $PROFILE_DIR（登录态还在，下次 start 直接是已登录）"
}

case "${1:-}" in
  start) shift; start "$@" ;;
  web-start) mkdir -p "$VNC_DIR"; web_start ;;   # root 跑这一条：只起网页桥，不碰 X 和浏览器
  web-stop) web_stop; echo "网页入口已停，$WEB_PORT 端口已关" ;;
  status) status ;;
  stop) stop ;;
  *) echo "用法: $0 {start [URL]|status|stop}   # 网页入口另需 sudo $0 web-start" >&2; exit 2 ;;
esac
