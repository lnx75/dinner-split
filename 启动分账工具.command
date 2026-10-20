#!/bin/zsh
cd -- "$(dirname -- "$0")" || exit 1
if ! command -v node >/dev/null 2>&1; then
  echo "请先安装 Node.js 20 或更新版本，然后重新双击本文件。"
  echo "按回车关闭。"
  read -r
  exit 1
fi
node scripts/launch.mjs
