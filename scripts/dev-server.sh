#!/usr/bin/env bash
# Instancia AISLADA de HermesWeb para probar cambios sin tocar la que estás usando:
# otro puerto, su propia config/datos/uploads y su propio servidor tmux.
#
#   scripts/dev-server.sh start [puerto]   (por defecto 7799) → imprime la URL y la contraseña
#   scripts/dev-server.sh stop
#
# Ábrela por http://localhost:PUERTO (no 127.0.0.1) para no mezclar cookies con tu sesión real.
set -euo pipefail
ROOT="$(cd "$(dirname "$(readlink -f "${BASH_SOURCE[0]}")")/.." && pwd)"
PORT="${2:-${HERMES_DEV_PORT:-7799}}"
DIR="${HERMES_DEV_DIR:-${TMPDIR:-/tmp}/hermesweb-dev-$PORT}"
SOCK="$HOME/.local/state/hermesweb-dev-$PORT.sock"   # ruta corta: los sockets Unix tienen límite de 108 caracteres

stop() {
  local pid; pid="$(cat "$DIR/pid" 2>/dev/null || true)"
  [[ -n "$pid" ]] && kill "$pid" 2>/dev/null || true
  # por si quedó otra instancia de prueba de este repo escuchando en el puerto
  for pid in $(ss -ltnpH "sport = :$PORT" 2>/dev/null | grep -o 'pid=[0-9]*' | cut -d= -f2); do
    [[ "$(readlink "/proc/$pid/cwd" 2>/dev/null)" == "$ROOT" ]] && tr '\0' '\n' < "/proc/$pid/environ" 2>/dev/null | grep -q "^HERMES_TMUX_SOCKET=$SOCK$" && kill "$pid"
  done
  tmux -S "$SOCK" kill-server 2>/dev/null || true
  rm -rf "$DIR" "$SOCK"
}

case "${1:-}" in
  start)
    stop
    mkdir -p "$DIR"/{cfg,data,up} "$(dirname "$SOCK")"
    PW="$(head -c 18 /dev/urandom | base64 | tr -dc 'A-Za-z0-9' | head -c 16)"
    HERMES_CONFIG_DIR="$DIR/cfg" node -e "import('$ROOT/auth.js').then(m => m.setPassword(process.argv[1]))" "$PW"
    echo "$PW" > "$DIR/password"
    tmux -S "$SOCK" -f "$ROOT/tmux.conf" start-server
    if ss -ltnH "sport = :$PORT" | grep -q .; then echo "el puerto $PORT está ocupado" >&2; exit 1; fi
    cd "$ROOT"
    env -u HERMES_VERSION HERMES_CONFIG_DIR="$DIR/cfg" HERMES_DATA_DIR="$DIR/data" HERMES_UPLOAD_DIR="$DIR/up" \
      HERMES_TMUX_SOCKET="$SOCK" PORT="$PORT" HOST=127.0.0.1 HERMES_HOST_LABEL="${HERMES_HOST_LABEL:-PRUEBA}" \
      nohup node --disable-warning=ExperimentalWarning server.js > "$DIR/log" 2>&1 &
    echo $! > "$DIR/pid"
    for _ in $(seq 50); do curl -fsS -o /dev/null "http://127.0.0.1:$PORT/login" 2>/dev/null && break; sleep 0.2; done
    curl -fsS -o /dev/null "http://127.0.0.1:$PORT/login" || { cat "$DIR/log"; exit 1; }
    echo "URL=http://localhost:$PORT"
    echo "PASSWORD_FILE=$DIR/password"
    echo "TMUX_SOCKET=$SOCK"
    echo "CONFIG_DIR=$DIR/cfg"
    echo "LOG=$DIR/log" ;;
  stop) stop; echo "detenida" ;;
  *) sed -n '2,9p' "$0" | sed 's/^# \{0,1\}//'; exit 1 ;;
esac
