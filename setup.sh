#!/bin/bash
# نصب یا به‌روزرسانی خودکار Arian Chat روی Ubuntu
# اجرا:            bash setup.sh
# اجرا با دامنه:   DOMAIN=chat.example.com bash setup.sh
# تعیین مدیر:      ADMIN=yourusername bash setup.sh
# (دامنه و مدیر یک بار تنظیم می‌شوند و در اجراهای بعدی به خاطر سپرده می‌شوند)
set -e
export DEBIAN_FRONTEND=noninteractive NEEDRESTART_MODE=a
APT="apt-get -y -o DPkg::Lock::Timeout=600"
REPO="https://github.com/arianmarani/arianchat.git"
APP=/opt/arian-chat
DATA=/opt/arian-data

echo "===== [1/6] Updating system ====="
$APT update
$APT install curl git ca-certificates openssl

echo "===== [2/6] Installing Node.js 22 ====="
if ! node -v 2>/dev/null | grep -Eq '^v(2[2-9]|[3-9][0-9])'; then
  curl -fsSL https://deb.nodesource.com/setup_22.x -o /tmp/nodesource.sh
  bash /tmp/nodesource.sh
  $APT install nodejs
fi
echo "Node: $(node -v)"

echo "===== [3/6] Installing pm2 ====="
npm install -g pm2

echo "===== [4/6] Downloading Arian Chat ====="
if [ -d "$APP/.git" ]; then
  git -C "$APP" pull
else
  rm -rf "$APP"
  git clone "$REPO" "$APP"
fi
cd "$APP"
npm install --omit=dev

echo "===== [5/6] Starting server ====="
mkdir -p "$DATA"
[ -f "$DATA/.jwt_secret" ] || openssl rand -hex 48 > "$DATA/.jwt_secret"
export JWT_SECRET="$(cat "$DATA/.jwt_secret")" DB_PATH="$DATA/messenger.db"
ADMIN="${ADMIN:-$(cat "$DATA/.admin" 2>/dev/null || true)}"
[ -n "$ADMIN" ] && echo "$ADMIN" > "$DATA/.admin"
export ADMIN_USERNAME="$ADMIN"
pm2 delete arian-chat >/dev/null 2>&1 || true
pm2 start server.js --name arian-chat --update-env
pm2 save
pm2 startup systemd -u root --hp /root >/dev/null

echo "===== [6/6] Network / domain ====="
command -v ufw >/dev/null && ufw allow 3000 >/dev/null || true

# دامنه یک بار تنظیم می‌شود و در اجراهای بعدی به خاطر سپرده می‌شود
DOMAIN="${DOMAIN:-$(cat "$DATA/.domain" 2>/dev/null || true)}"
if [ -n "$DOMAIN" ]; then
  echo "$DOMAIN" > "$DATA/.domain"
  $APT install caddy
  cat > /etc/caddy/Caddyfile <<CADDY
$DOMAIN {
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
echo " Arian Chat is running:  http://$IP:3000"
[ -n "$DOMAIN" ] && echo " With domain (HTTPS):    https://$DOMAIN"
[ -n "$ADMIN" ] && echo " Admin:                  @$ADMIN"
echo "=============================================="
