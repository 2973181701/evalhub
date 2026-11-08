#!/usr/bin/env bash
# EvalHub · 轻量应用服务器一键部署（Ubuntu 24.04 / 2C2G 实测规格）
#
# 设计取舍：
#   - 不用 Docker：2G 内存里 Docker daemon + 容器 + PG 抢内存更凶，
#     而且国内拉镜像还得配加速器；apt 装原生服务更快更稳。
#   - PostgreSQL 只监听 127.0.0.1：数据库绝不对公网暴露，这点没得商量。
#   - 后端用 pm2 托管并开机自启：nohup 那种方式服务器一重启就没了。
#   - 前端 build 成静态交给 nginx：不用跑 vite dev server 上生产。
#
# 用法（在服务器上，代码已放到 /opt/evalhub）：
#   sudo bash deploy/bootstrap.sh
#
# 幂等：可重复执行，已存在的库/配置不会被重复创建（会更新）。

set -euo pipefail

APP_DIR="${APP_DIR:-/opt/evalhub}"
DB_NAME="${DB_NAME:-evalhub}"
DB_USER="${DB_USER:-evalhub}"
DB_PASS="${DB_PASS:-$(head -c 18 /dev/urandom | base64 | tr -dc 'A-Za-z0-9' | head -c 20)}"
NODE_PORT="${NODE_PORT:-3000}"
ENV_FILE="$APP_DIR/backend/.env"

log() { printf '\n\033[1;36m== %s ==\033[0m\n' "$*"; }

# 幂等：重跑时复用已有连接串。
# 否则每次都会生成新随机密码，但已存在的 PG 角色密码不会跟着改 —— 重跑即断连。
if [ -z "${DATABASE_URL:-}" ] && [ -f "$ENV_FILE" ]; then
  DATABASE_URL="$(grep -E '^DATABASE_URL=' "$ENV_FILE" | tail -1 | cut -d= -f2- || true)"
  [ -n "${DATABASE_URL:-}" ] && echo "  复用已有 DATABASE_URL（重跑幂等）"
fi

[ "$(id -u)" -eq 0 ] || { echo "请用 sudo 运行"; exit 1; }

# ─────────────────────────── 1. swap ───────────────────────────
log "1/7 配置 swap（2G 内存跑 PG + node build 很容易 OOM）"
if ! swapon --show | grep -q '/swapfile'; then
  fallocate -l 2G /swapfile || dd if=/dev/zero of=/swapfile bs=1M count=2048
  chmod 600 /swapfile
  mkswap /swapfile >/dev/null
  swapon /swapfile
  grep -q '^/swapfile' /etc/fstab || echo '/swapfile none swap sw 0 0' >> /etc/fstab
  echo "  已启用 2G swap"
else
  echo "  swap 已存在，跳过"
fi

# ─────────────────────────── 2. 依赖 ───────────────────────────
log "2/7 安装 postgresql / nginx / nodejs"
export DEBIAN_FRONTEND=noninteractive
apt-get update -qq
apt-get install -y -qq postgresql postgresql-contrib nginx nodejs npm git curl >/dev/null
echo "  node $(node -v) / npm $(npm -v)"
echo "  $(psql --version)"

# ─────────────────────────── 3. 数据库 ───────────────────────────
log "3/7 建库建角色（仅监听 127.0.0.1）"
sudo -u postgres psql -tAc "SELECT 1 FROM pg_roles WHERE rolname='${DB_USER}'" | grep -q 1 \
  || sudo -u postgres psql -c "CREATE ROLE ${DB_USER} LOGIN PASSWORD '${DB_PASS}'" >/dev/null
sudo -u postgres psql -tAc "SELECT 1 FROM pg_database WHERE datname='${DB_NAME}'" | grep -q 1 \
  || sudo -u postgres createdb -O "${DB_USER}" "${DB_NAME}"

# 确认只监听本地（Debian/Ubuntu 默认就是 localhost，这里做一次断言）
PG_CONF="$(sudo -u postgres psql -tAc 'SHOW config_file')"
if grep -qE "^\s*listen_addresses\s*=\s*'\*'" "$PG_CONF"; then
  echo "  ⚠ 检测到 listen_addresses='*'，改为 localhost"
  sed -i "s/^\s*listen_addresses.*/listen_addresses = 'localhost'/" "$PG_CONF"
  systemctl restart postgresql
fi

export PGPASSWORD="${DB_PASS}"
if [ -z "${DATABASE_URL:-}" ]; then
  DATABASE_URL="postgres://${DB_USER}:${DB_PASS}@127.0.0.1:5432/${DB_NAME}"
fi
psql "$DATABASE_URL" -tAc 'SELECT 1' >/dev/null && echo "  连接串可用"

# ─────────────────────────── 4. 表结构 ───────────────────────────
log "4/7 建表 + 导入数据集"
cd "$APP_DIR"
psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -f db/schema.sql >/dev/null
for f in db/migrations/*.sql; do
  [ -e "$f" ] || continue
  psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -f "$f" >/dev/null
  echo "  已应用 $(basename "$f")"
done

npm install --no-audit --no-fund >/dev/null 2>&1 || true
DATABASE_URL="$DATABASE_URL" node db/migrate.mjs
DATABASE_URL="$DATABASE_URL" node db/seeds-sync.mjs

# ─────────────────────────── 5. 后端 ───────────────────────────
log "5/7 构建引擎 + 启动后端（pm2）"
cd "$APP_DIR/core" && moon build --target js 2>/dev/null || echo "  ⚠ 未安装 moon，若 core/_build 已随仓库提供可忽略"

cd "$APP_DIR/backend"
npm install --no-audit --no-fund >/dev/null

# 环境变量落到 .env（server.js 启动时自动读取），权限 600
# 重跑时保留已有的 GLM_API_KEY 与 JWT 密钥，避免把服务器上的配置冲掉
PRESERVED_GLM=""
PRESERVED_JWT=""
if [ -f "$ENV_FILE" ]; then
  PRESERVED_GLM="$(grep -E '^GLM_API_KEY=' "$ENV_FILE" | tail -1 || true)"
  PRESERVED_JWT="$(grep -E '^EVALHUB_JWT_SECRET=' "$ENV_FILE" | tail -1 | cut -d= -f2- || true)"
fi

cat > "$ENV_FILE" <<ENV
DATABASE_URL=${DATABASE_URL}
PORT=${NODE_PORT}
EVALHUB_AUTH=${EVALHUB_AUTH:-1}
EVALHUB_JWT_SECRET=${EVALHUB_JWT_SECRET:-${PRESERVED_JWT:-$(head -c 32 /dev/urandom | base64 | tr -dc 'A-Za-z0-9' | head -c 40)}}
EVALHUB_DATASET=evalhub-core
ENV
[ -n "$PRESERVED_GLM" ] && echo "$PRESERVED_GLM" >> "$ENV_FILE"
chmod 600 "$ENV_FILE"

# GLM 密钥只从环境变量传入，不落进仓库、不写进打包产物
if [ -n "${GLM_API_KEY:-}" ]; then
  printf 'GLM_API_KEY=%s\nGLM_MODEL=%s\n' "$GLM_API_KEY" "${GLM_MODEL:-glm-4-flash}" >> "$APP_DIR/backend/.env"
  echo "  已写入 GLM_API_KEY（长度 ${#GLM_API_KEY}）"
else
  echo "  ⚠ 未提供 GLM_API_KEY：真实模型调用不可用，仅 local 复算可用"
fi

npm i -g pm2 >/dev/null 2>&1 || true
# 不再 set -a / . .env：server.js 启动时会自己读 backend/.env（见 backend/env.js），
# 于是 pm2 restart 也能拿到最新密钥，不必再记 --update-env。
pm2 delete evalhub-api >/dev/null 2>&1 || true
pm2 start server.js --name evalhub-api --time --max-memory-restart 600M
pm2 save >/dev/null
pm2 startup systemd -u root --hp /root >/dev/null 2>&1 || true

# ─────────────────────────── 6. 前端 ───────────────────────────
log "6/7 构建前端静态文件"
cd "$APP_DIR/frontend"
npm install --no-audit --no-fund >/dev/null
npm run build >/dev/null
echo "  产物：$(du -sh dist | cut -f1)  $(ls dist/assets | wc -l) 个资源文件"

# ─────────────────────────── 7. nginx ───────────────────────────
log "7/7 配置 nginx"
sed -e "s#__APP_DIR__#${APP_DIR}#g" -e "s#__PORT__#${NODE_PORT}#g" \
  "$APP_DIR/deploy/nginx-evalhub.conf" > /etc/nginx/sites-available/evalhub
ln -sf /etc/nginx/sites-available/evalhub /etc/nginx/sites-enabled/evalhub
rm -f /etc/nginx/sites-enabled/default
nginx -t
systemctl reload nginx

log "完成"
cat <<EOF

  访问      : http://$(curl -s --max-time 3 ifconfig.me || echo '<公网IP>')/
  后端      : pm2 logs evalhub-api
  数据库    : psql "$DATABASE_URL"
  管理账号  : DATABASE_URL="$DATABASE_URL" node db/create-user.mjs --email admin@example.com --password '<你设一个>' --role admin

  还需要在云控制台「防火墙」放行 80（443 若上 HTTPS 也放行）。
  DATABASE_URL 已写入 $APP_DIR/backend/.env（权限 600），不要提交到 git。

EOF
