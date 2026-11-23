#!/usr/bin/env bash
# Publica HermesWeb por HTTPS dentro de tu tailnet (solo tus dispositivos de Tailscale lo ven):
#   https://<esta-máquina>.<tu-tailnet>.ts.net  →  http://127.0.0.1:7681
# Con HTTPS el navegador permite notificaciones, portapapeles e instalar la app.
#
#   scripts/tailscale-serve.sh          activar
#   scripts/tailscale-serve.sh off      desactivar
#
# Requisitos: Tailscale instalado y conectado, y HTTPS habilitado en la tailnet
# (consola de Tailscale → DNS → "Enable HTTPS"). HermesWeb puede seguir escuchando en 127.0.0.1.
set -euo pipefail
CFG="$HOME/.config/hermesweb/deploy.env"
[[ -f "$CFG" ]] && { set -a; source "$CFG"; set +a; }
PORT="${HERMES_PORT:-7681}"
command -v tailscale >/dev/null || { echo "tailscale no está instalado" >&2; exit 1; }

if [[ "${1:-}" == off ]]; then
  tailscale serve --https=443 off
  echo "HTTPS de tailscale desactivado"; exit 0
fi

tailscale serve --bg --https=443 "http://127.0.0.1:$PORT"
name="$(tailscale status --json | python3 -c 'import json,sys; print(json.load(sys.stdin)["Self"]["DNSName"].rstrip("."))')"
echo
echo "HermesWeb: https://$name"
echo "Sugerido en $CFG (para que los avisos al celular abran esta URL):"
echo "  HERMES_PUBLIC_URL=https://$name"
