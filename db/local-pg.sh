#!/usr/bin/env bash
# EvalHub · 本地 PostgreSQL 一键启动（免管理员、免 Docker、免重启）
#
# 前置：把 PostgreSQL Windows 二进制包解压到 _tools/pgsql（含 bin/initdb.exe）
#
#   ./db/local-pg.sh up      # 初始化（仅首次）+ 启动 + 建库
#   ./db/local-pg.sh schema  # 建库后执行 db/schema.sql
#   ./db/local-pg.sh migrate # 执行 db/migrate.mjs
#   ./db/local-pg.sh psql    # 交互式 psql
#   ./db/local-pg.sh status
#   ./db/local-pg.sh down
#
# 默认端口 5433（避开可能已存在的 5432），trust 认证仅用于本机开发。

set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
# 默认路径必须全 ASCII：initdb 在含中文的路径下会直接报
#   FATAL: invalid byte sequence for encoding "UTF8"
# 所以二进制与数据目录统一放在仓库外的 D:/evalhub-pg
PGHOME="${PGHOME:-D:/evalhub-pg/pgsql}"
PGDATA="${PGDATA:-D:/evalhub-pg/data}"
PGPORT="${PGPORT:-5433}"
PGDB="${PGDB:-evalhub}"
PGUSER="${PGUSER:-postgres}"

BIN="$PGHOME/bin"

die() { echo "错误：$*" >&2; exit 1; }

[ -d "$BIN" ] || die "未找到 $BIN，请先把 PostgreSQL 二进制包解压到 $PGHOME"

cmd="${1:-up}"

case "$cmd" in
  up)
    if [ ! -d "$PGDATA" ]; then
      echo "[1/3] 初始化数据目录 $PGDATA"
      "$BIN/initdb.exe" -D "$PGDATA" -U "$PGUSER" --auth-local=trust --auth-host=trust -E UTF8 --locale=C >/dev/null
    else
      echo "[1/3] 数据目录已存在，跳过 initdb"
    fi

    if "$BIN/pg_ctl.exe" -D "$PGDATA" status >/dev/null 2>&1; then
      echo "[2/3] 服务已在运行"
    else
      echo "[2/3] 启动 PostgreSQL（端口 $PGPORT）"
      "$BIN/pg_ctl.exe" -D "$PGDATA" -l "$PGDATA/server.log" -o "-p $PGPORT" -w start >/dev/null
    fi

    echo "[3/3] 确保数据库 $PGDB 存在"
    "$BIN/psql.exe" -h 127.0.0.1 -p "$PGPORT" -U "$PGUSER" -d postgres -tAc \
      "SELECT 1 FROM pg_database WHERE datname='$PGDB'" | grep -q 1 \
      || "$BIN/createdb.exe" -h 127.0.0.1 -p "$PGPORT" -U "$PGUSER" "$PGDB"

    echo "就绪： postgres://$PGUSER@127.0.0.1:$PGPORT/$PGDB"
    ;;

  schema)
    "$BIN/psql.exe" -h 127.0.0.1 -p "$PGPORT" -U "$PGUSER" -d "$PGDB" -v ON_ERROR_STOP=1 -f "$ROOT/db/schema.sql"
    ;;

  migrate)
    DATABASE_URL="postgres://$PGUSER@127.0.0.1:$PGPORT/$PGDB" node "$ROOT/db/migrate.mjs"
    ;;

  psql)
    exec "$BIN/psql.exe" -h 127.0.0.1 -p "$PGPORT" -U "$PGUSER" -d "$PGDB"
    ;;

  status)
    "$BIN/pg_ctl.exe" -D "$PGDATA" status || true
    ;;

  down)
    "$BIN/pg_ctl.exe" -D "$PGDATA" -m fast -w stop
    ;;

  *)
    die "未知命令 $cmd（可用：up / schema / migrate / psql / status / down）"
    ;;
esac
