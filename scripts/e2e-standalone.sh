#!/usr/bin/env bash
# e2e-standalone.sh —— 无 ai-toolkit 环境端到端验证（M4 起按仅用户级 scope 模型） by AI.Coding
#
# 作用：在隔离 HOME + 隔离 npm prefix 下安装 atk，注册 global/scoped 集合，
# 验证「npm install -g atk 后全套命令可用、scope 安装模型正确、不依赖任何 ai-toolkit 文件」。
# 用法：bash scripts/e2e-standalone.sh [--keep]
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PKG_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
TMP="$(mktemp -d)"
KEEP=0
[ "${1:-}" = "--keep" ] && KEEP=1
trap 'rm -rf "$TMP"' EXIT
[ "$KEEP" = 1 ] && trap - EXIT

echo "==> 隔离环境: $TMP"
export HOME="$TMP/home"
export XDG_CONFIG_HOME="$TMP/config"
mkdir -p "$HOME" "$TMP/npm"
export npm_config_prefix="$TMP/npm"

echo "==> npm install -g（本地包，离线）"
npm install --prefix "$TMP/npm" -g "$PKG_DIR" >/dev/null 2>&1
export PATH="$TMP/npm/bin:$PATH"
atk --version

echo "==> 造两个技能集合目录（global 只含 alpha；scoped 只含 beta）"
GLOB_COLL="$TMP/glob-collection"
SCOP_COLL="$TMP/scop-collection"
mkdir -p "$GLOB_COLL/skills/alpha" "$SCOP_COLL/skills/beta"
printf -- '---\nname: alpha\n---\n' > "$GLOB_COLL/skills/alpha/SKILL.md"
printf -- '---\nname: beta\n---\n' > "$SCOP_COLL/skills/beta/SKILL.md"

echo "==> 注册集合（global 注册即装 + scoped 默认停用）"
atk collection add "$GLOB_COLL" --name demo-global --scope global
atk collection add "$SCOP_COLL" --name team-demo --scope scoped
atk collection list | grep -q "demo-global" && echo "list OK"

echo "==> M3: scoped 默认不装（apply 后只有 global 技能 alpha）"
atk apply >/dev/null
for c in .claude .config/opencode .cc-switch .agents .dsh; do
  if [ -h "$HOME/$c/skills/alpha" ] || [ -h "$HOME/$c/skill/alpha" ]; then
    :
  else
    echo "缺少 $c 用户级链接"; exit 1
  fi
  if [ -h "$HOME/$c/skills/beta" ] || [ -h "$HOME/$c/skill/beta" ]; then
    echo "scoped 集合未 enable 却被安装（beta）"; exit 1
  fi
done
echo "M3 scoped 默认不装 OK"

echo "==> enable scoped → apply → beta 安装（5 客户端）"
atk collection enable team-demo >/dev/null
atk apply >/dev/null
for c in .claude .config/opencode .cc-switch .agents .dsh; do
  if [ -h "$HOME/$c/skills/beta" ] || [ -h "$HOME/$c/skill/beta" ]; then
    :
  else
    echo "缺少 $c scoped 技能链接 beta"; exit 1
  fi
done
echo "enable 后安装 OK"

echo "==> 校验 + 导出"
atk validate collection "$GLOB_COLL" >/dev/null && echo "validate OK"
atk collection export demo-global alpha --to "$TMP/exported" >/dev/null \
  && test -f "$TMP/exported/skills/alpha/SKILL.md" && echo "export OK"

echo "==> 状态确认（无任何 ai-toolkit 配置依赖）"
if find "$HOME/.config" -maxdepth 2 -name 'ai-toolkit' 2>/dev/null | grep -q .; then
  echo "意外依赖 ai-toolkit 配置"; exit 1
fi
echo "无 ai-toolkit 配置依赖 OK"

echo
echo "✅ 独立安装端到端验证通过（新 scope 模型）"
