#!/usr/bin/env bash
# Commit + push + release en GitHub + deploy en Docker, en un solo paso.
#
#   scripts/release.sh [patch|minor|major] [-m "mensaje"] [-y] [--no-deploy]
#
#   1. si hay cambios sin commitear, los commitea con -m "mensaje" (obligatorio en ese caso)
#   2. sube la versión de package.json (npm version) y crea el tag vX.Y.Z
#   3. git push de main + el tag
#   4. crea el release en GitHub con notas generadas a partir de los commits (gh)
#   5. scripts/deploy.sh vX.Y.Z en esta máquina (en otras máquinas: scripts/deploy.sh)
set -euo pipefail

ROOT="$(cd "$(dirname "$(readlink -f "${BASH_SOURCE[0]}")")/.." && pwd)"
cd "$ROOT"
die() { echo "release: $*" >&2; exit 1; }
say() { echo "▸ $*"; }

bump=patch msg="" yes=0 deploy=1
while (( $# )); do
  case "$1" in
    patch|minor|major) bump="$1" ;;
    -m) msg="${2:?falta el mensaje después de -m}"; shift ;;
    -y) yes=1 ;;
    --no-deploy) deploy=0 ;;
    -h|--help) sed -n '2,11p' "$0" | sed 's/^# \{0,1\}//'; exit 0 ;;
    *) die "argumento desconocido: $1" ;;
  esac
  shift
done

command -v gh >/dev/null || die "falta gh (GitHub CLI)"
[[ "$(git branch --show-current)" == main ]] || die "los releases se hacen desde main"

git fetch --quiet origin
[[ -z "$(git rev-list HEAD..origin/main 2>/dev/null)" ]] || die "origin/main tiene commits que no tienes: git pull --rebase"

# 1. commit
if [[ -n "$(git status --porcelain)" ]]; then
  git status --short
  [[ -n "$msg" ]] || die "hay cambios sin commitear: pasa el mensaje con -m \"...\""
  git add -A
  git commit -q -m "$msg"
  say "commit: $msg"
fi

# 2. versión
cur="$(node -p "require('./package.json').version")"
IFS=. read -r ma mi pa <<<"$cur"
case "$bump" in
  major) next="$((ma+1)).0.0" ;;
  minor) next="$ma.$((mi+1)).0" ;;
  patch) next="$ma.$mi.$((pa+1))" ;;
esac
last="$(git describe --tags --abbrev=0 --match 'v*' 2>/dev/null || true)"
echo
echo "Release v$next  (actual: ${last:-ninguno})"
git log --oneline ${last:+"$last"..}HEAD | sed 's/^/  /'
echo
if (( ! yes )); then
  read -rp "¿Publicar v$next$( ((deploy)) && echo ' y desplegar')? [s/N] " ok
  [[ "$ok" =~ ^[sSyY]$ ]] || die "cancelado (el commit, si hubo, queda local)"
fi

npm version "$next" -m "Release v%s" >/dev/null
say "tag v$next"

# 3. push
git push --quiet origin main "v$next"
say "push a origin"

# 4. release en GitHub
gh release create "v$next" --verify-tag --title "v$next" --generate-notes >/dev/null
say "release: $(gh release view "v$next" --json url -q .url)"

# 5. deploy
if (( deploy )); then
  "$ROOT/scripts/deploy.sh" "v$next"
fi
