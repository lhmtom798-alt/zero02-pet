#!/usr/bin/env bash
# 一键验收：重建 → 四个角色五视图 → 各状态 → 真实尺寸预览 → 失败即退出
# 用法：bash tools/verify.sh [quick]
set -euo pipefail
cd "$(dirname "$0")/.."
NODE="${NODE:-~/.dsh/dsh-runtimes/dsh-primary-runtime/dependencies/node/bin/node}"
QUICK="${1:-}"

echo "== build =="
python3 build.py

echo "== dev server =="
if ! curl -sf -o /dev/null "http://127.0.0.1:8899/lab/"; then
  (nohup python3 tools/serve.py > shots/serve.log 2>&1 &)
  sleep 1
fi
curl -sf -o /dev/null "http://127.0.0.1:8899/lab/" || { echo "dev server 没起来"; exit 1; }

shoot() {  # shoot <url> <out> <size> [ready]
  echo "-- $2"
  "$NODE" tools/shot.mjs --url "$1" --out "$2" --size "$3" --wait 900 --ready "${4:-window.__LAB_READY}" >/tmp/z02-shot.log 2>&1 \
    || { echo "FAIL $2"; cat /tmp/z02-shot.log; exit 1; }
  if grep -qE "\[(pageerror|console\.error)\]" /tmp/z02-shot.log; then
    echo "页面报错 $2"; cat /tmp/z02-shot.log; exit 1
  fi
}

for c in chibi onee genki whale; do
  shoot "http://127.0.0.1:8899/lab/?char=$c&mode=sheet" "shots/qa-$c-sheet.png" "1700x800"
done
if [ "$QUICK" != "quick" ]; then
  for st in happy talk sleep shy wink stretch eat; do
    shoot "http://127.0.0.1:8899/lab/?char=chibi&mode=single&state=$st" "shots/qa-chibi-$st.png" "420x560"
  done
fi

echo "== plugin preview (3D, 195x300 真实桌宠尺寸) =="
shoot "http://127.0.0.1:8899/preview/?pkg=zero02-pet&z02debug=1&skin=chibi" "shots/qa-preview.png" "900x700" true
shoot "http://127.0.0.1:8899/preview/?pkg=zero02-pet&z02debug=1&skin=onee" "shots/qa-preview-onee.png" "900x700" true

echo "== OK =="
