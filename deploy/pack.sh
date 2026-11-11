#!/usr/bin/env bash
# EvalHub · 打部署包（在本机执行，产物上传到服务器 /opt/evalhub）
#
# 关键点：
#   1. 把 core/_build 一起打进去 —— 它是 .gitignore 的，但后端启动必须要有这个 JS 引擎产物，
#      否则服务器上还得装 MoonBit 工具链。
#   2. 排除 node_modules / dist / reports：体积大且服务器会自己装。
#   3. **排除 config.json**：里面是 GLM 密钥，绝不能进部署包。
#
# 用法：bash deploy/pack.sh
# 产物：dist/evalhub-deploy.tar.gz

set -euo pipefail
cd "$(dirname "$0")/.."
OUT="dist/evalhub-deploy.tar.gz"
mkdir -p dist

[ -f core/_build/js/debug/build/src/src.js ] || {
  echo "缺少 MoonBit 引擎产物，先执行： cd core && moon build --target js"
  exit 1
}

tar -czf "$OUT" \
  --exclude='node_modules' \
  --exclude='frontend/dist' \
  --exclude='.git' \
  --exclude='config.json' \
  --exclude='reports/*.json' \
  --exclude='*.log' \
  --exclude='*.bak' \
  --exclude='data/out' \
  backend core data db deploy frontend tools test reports sdk .github package.json

echo "已生成 $(du -h "$OUT" | cut -f1)  $OUT"
echo "包含 core/_build：$(tar -tzf "$OUT" | grep -c 'core/_build') 个文件"
