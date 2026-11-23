#!/usr/bin/env bash
# Despliega HermesWeb en Docker en ESTA máquina, a partir de un release (tag git vX.Y.Z).
#
#   scripts/deploy.sh               último release
#   scripts/deploy.sh v0.2.0        un release concreto (también sirve para volver atrás)
#   scripts/deploy.sh --status      versión desplegada y estado
#
# Construye la imagen exactamente desde el tag (git archive, sin cambios locales), asegura el
# servidor tmux del host (servicio de usuario hermes-tmux) y levanta el contenedor.
# Configuración opcional en ~/.config/hermesweb/deploy.env:
#   HERMES_BIND=127.0.0.1   (0.0.0.0 o la IP de Tailscale para acceder desde la tablet)
#   HERMES_PORT=7681
#   HERMES_HOST_LABEL=laptop
set -euo pipefail

ROOT="$(cd "$(dirname "$(readlink -f "${BASH_SOURCE[0]}")")/.." && pwd)"
cd "$ROOT"
die() { echo "deploy: $*" >&2; exit 1; }
say() { echo "▸ $*"; }

CFG="$HOME/.config/hermesweb"
SOCK="$HOME/.local/state/hermesweb/tmux.sock"
[[ -f "$CFG/deploy.env" ]] && { set -a; source "$CFG/deploy.env"; set +a; }
export HERMES_PORT="${HERMES_PORT:-7681}" HERMES_UID="$(id -u)" HERMES_GID="$(id -g)"

if [[ "${1:-}" == "--status" ]]; then
  docker inspect hermesweb --format 'Contenedor: {{.State.Status}}  imagen {{.Config.Image}}  desde {{.State.StartedAt}}' 2>/dev/null || echo "Contenedor: no existe"
  tmux -S "$SOCK" show-options -s exit-empty >/dev/null 2>&1 && echo "tmux host: corriendo ($(tmux -S "$SOCK" ls 2>/dev/null | wc -l) sesiones)" || echo "tmux host: detenido"
  exit 0
fi

# --- versión ---
git fetch --tags --quiet origin 2>/dev/null || say "sin conexión con origin: uso los tags locales"
ver="${1:-latest}"
[[ "$ver" == latest ]] && ver="$(git tag -l 'v*' --sort=-v:refname | head -1)"
[[ -n "$ver" ]] || die "no hay releases todavía (crea uno con scripts/release.sh)"
git rev-parse -q --verify "refs/tags/$ver" >/dev/null || die "no existe el tag $ver"
export HERMES_VERSION="$ver"

# --- carpetas compartidas: crearlas como tuyas antes de que Docker las cree como root ---
mkdir -p "$CFG" "$HOME/.local/share/hermesweb" "$HOME/.local/state/hermesweb" "$HOME/.cache/hermesweb"
chmod 700 "$CFG" "$HOME/.local/state/hermesweb"

# --- imagen ---
if docker image inspect "hermesweb:$ver" >/dev/null 2>&1; then
  say "imagen hermesweb:$ver ya existe"
else
  say "construyendo hermesweb:$ver"
  git archive --format=tar "$ver" | docker build -q --build-arg "VERSION=$ver" -t "hermesweb:$ver" - >/dev/null
fi
docker tag "hermesweb:$ver" hermesweb:latest

# --- contraseña (primera vez) ---
if [[ ! -f "$CFG/auth.json" ]]; then
  say "no hay contraseña configurada: defínela ahora"
  docker run --rm -it -u "$HERMES_UID:$HERMES_GID" -e HOME="$HOME" -v "$CFG:$CFG" "hermesweb:$ver" node set-password.js
fi

# --- servidor tmux del host ---
git show "$ver:tmux.conf" > "$CFG/tmux.conf"
UNIT_DIR="$HOME/.config/systemd/user"
if command -v systemctl >/dev/null && systemctl --user show-environment >/dev/null 2>&1; then
  mkdir -p "$UNIT_DIR"
  git show "$ver:deploy/hermes-tmux.service" > "$UNIT_DIR/hermes-tmux.service"
  systemctl --user daemon-reload
  systemctl --user enable --quiet hermes-tmux.service
  systemctl --user restart hermes-tmux.service   # start-server es inocuo si ya corre
else
  tmux -S "$SOCK" -f "$CFG/tmux.conf" start-server
fi
tmux -S "$SOCK" source-file "$CFG/tmux.conf" 2>/dev/null || true
tmux -S "$SOCK" show-options -s exit-empty >/dev/null 2>&1 || die "no pude arrancar el servidor tmux del host ($SOCK)"

# --- puerto ocupado por otra cosa (p. ej. un `npm start` manual) ---
if ss -ltnH "sport = :$HERMES_PORT" | grep -q . && ! docker ps -q -f name='^hermesweb$' | grep -q .; then
  die "el puerto $HERMES_PORT está ocupado (¿un 'npm start' corriendo? deténlo con Ctrl+C)"
fi

# --- contenedor ---
say "levantando hermesweb:$ver"
docker compose -f "$ROOT/docker-compose.yml" up -d --remove-orphans --force-recreate >/dev/null

for _ in $(seq 30); do
  curl -fsS -o /dev/null "http://127.0.0.1:$HERMES_PORT/login" 2>/dev/null && break
  sleep 1
done
if ! curl -fsS -o /dev/null "http://127.0.0.1:$HERMES_PORT/login" 2>/dev/null; then
  docker logs --tail 30 hermesweb >&2 || true
  die "el contenedor no responde en el puerto $HERMES_PORT"
fi

# --- limpieza: conservar las 3 imágenes más recientes (para volver atrás rápido) ---
docker image ls hermesweb --format '{{.Tag}}' | grep '^v' | sort -rV | tail -n +4 |
  while read -r t; do docker rmi -f "hermesweb:$t" >/dev/null 2>&1 || true; done

say "HermesWeb $ver desplegado → http://${HERMES_BIND:-127.0.0.1}:$HERMES_PORT"
