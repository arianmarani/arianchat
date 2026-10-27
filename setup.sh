#!/bin/bash
# نصب یا به‌روزرسانی خودکار Pingo Chat (Next.js) روی Ubuntu
#
#   bash setup.sh                                  نصب / به‌روزرسانی
#   DOMAIN=pingochat.ir,www.pingochat.ir bash setup.sh   تنظیم دامنه(ها) با HTTPS
#   ADMIN=arian bash setup.sh                      تعیین مدیر (چند نفر: ADMIN=arian,sara)
#   REPO=https://github.com/USER/REPO.git bash setup.sh  تغییر مخزن GitHub
#
# دامنه، مدیر و مخزن یک بار تنظیم می‌شوند و در اجراهای بعدی به خاطر سپرده می‌شوند.
# پیام‌ها، حساب‌ها و فایل‌ها در /opt/arian-data می‌مانند و با به‌روزرسانی پاک نمی‌شوند.
set -e
export DEBIAN_FRONTEND=noninteractive NEEDRESTART_MODE=a
APT="apt-get -y -o DPkg::Lock::Timeout=600"
APP=/opt/pingo-chat
DATA=/opt/arian-data
mkdir -p "$DATA"
remember() { # remember NAME VALUE FILE
  local v="$2"; [ -z "$v" ] && v="$(cat "$DATA/$3" 2>/dev/null || true)"
  [ -n "$v" ] && echo "$v" > "$DATA/$3"; printf '%s' "$v"
}
REPO="$(remember REPO "$REPO" .repo)"
REPO="${REPO:-https://github.com/arianmarani/pingochat.git}"
echo "$REPO" > "$DATA/.repo"
DOMAIN="$(remember DOMAIN "$DOMAIN" .domain)"
ADMIN="$(remember ADMIN "$ADMIN" .admin)"

echo "===== [1/7] Updating system ====="
$APT update
$APT install curl git ca-certificates openssl

echo "===== [2/7] Memory (swap for next build) ====="
if [ "$(swapon --show | wc -l)" -eq 0 ] && [ ! -f /swapfile ]; then
  fallocate -l 2G /swapfile || dd if=/dev/zero of=/swapfile bs=1M count=2048
  chmod 600 /swapfile && mkswap /swapfile && swapon /swapfile
  grep -q '/swapfile' /etc/fstab || echo '/swapfile none swap sw 0 0' >> /etc/fstab
fi

echo "===== [3/7] Installing Node.js 22 ====="
if ! node -e 'const [a,b]=process.versions.node.split(".").map(Number);process.exit(a>22||(a===22&&b>=13)?0:1)' 2>/dev/null; then
  curl -fsSL https://deb.nodesource.com/setup_22.x -o /tmp/nodesource.sh
  bash /tmp/nodesource.sh
  $APT install nodejs
fi
echo "Node: $(node -v)"
npm install -g pm2

echo "===== [4/7] Downloading Pingo Chat ====="
if [ -d "$APP/.git" ]; then
  git -C "$APP" remote set-url origin "$REPO"
  git -C "$APP" fetch --depth 1 origin
  git -C "$APP" reset --hard FETCH_HEAD
else
  rm -rf "$APP"
  git clone --depth 1 "$REPO" "$APP"
fi
cd "$APP"

echo "===== [5/7] Installing packages and building (a few minutes) ====="
if [ -f package-lock.json ]; then npm ci; else npm install; fi
NEXT_TELEMETRY_DISABLED=1 NODE_OPTIONS=--max-old-space-size=1536 npm run build

echo "===== [6/7] Starting server ====="
[ -f "$DATA/.jwt_secret" ] || openssl rand -hex 48 > "$DATA/.jwt_secret"
export JWT_SECRET="$(cat "$DATA/.jwt_secret")" DB_PATH="$DATA/messenger.db" ADMIN_USERNAME="$ADMIN"
export NODE_ENV=production NEXT_TELEMETRY_DISABLED=1 PORT=3000
pm2 delete arian-chat >/dev/null 2>&1 || true   # نسخه‌ی قبلی (Arian Chat)
pm2 delete pingo-chat >/dev/null 2>&1 || true
pm2 start server.js --name pingo-chat --update-env -- --prod
pm2 save
pm2 startup systemd -u root --hp /root >/dev/null

echo "===== [7/7] Network / domain ====="
command -v ufw >/dev/null && ufw allow 3000 >/dev/null || true
if [ -n "$DOMAIN" ]; then
  $APT install caddy
  SITES="$(echo "$DOMAIN" | sed 's/ //g; s/,/, /g')"
  cat > /etc/caddy/Caddyfile <<CADDY
$SITES {
	encode zstd gzip
	reverse_proxy localhost:3000
}
CADDY
  command -v ufw >/dev/null && { ufw allow 80 >/dev/null; ufw allow 443 >/dev/null; } || true
  systemctl enable caddy >/dev/null 2>&1 || true
  systemctl restart caddy
fi

IP="$(curl -s4 --max-time 5 ifconfig.me || hostname -I | awk '{print $1}')"
echo
echo "=============================================="
echo " Pingo Chat is running:  http://$IP:3000"
[ -n "$DOMAIN" ] && echo " Domain(s) with HTTPS:   $DOMAIN"
[ -n "$ADMIN" ] && echo " Admin:                  @$ADMIN"
echo "=============================================="
