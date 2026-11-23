# HermesWeb

Panel web en tiempo real para tus sesiones de Claude Code (o cualquier comando de consola).
Cada sesión es una terminal real (pty + xterm.js) respaldada por **tmux**, así que:

- las sesiones siguen vivas aunque cierres el navegador o reinicies el servidor web,
- puedes abrir la misma sesión desde el navegador **y** desde una terminal a la vez.

## Uso

### Con Docker (recomendado)

```bash
scripts/deploy.sh            # último release: construye la imagen, pide la contraseña la 1.ª vez y levanta
```

El contenedor corre **solo la web**; el servidor tmux y las sesiones de claude corren en el **host**
(servicio de usuario `hermes-tmux`, socket `~/.local/state/hermesweb/tmux.sock`). Así claude sigue
usando tus proyectos, herramientas y `~/.claude`, y las sesiones sobreviven a reinicios o
actualizaciones del contenedor. El contenedor usa tu uid y ve tu `$HOME` en la misma ruta
(solo lectura, salvo las carpetas de HermesWeb).

- Configuración en `~/.config/hermesweb/deploy.env` (`HERMES_BIND`, `HERMES_PORT`, `HERMES_HOST_LABEL`).
- Para que el tmux del host arranque al prender la máquina sin iniciar sesión: `loginctl enable-linger $USER`.
- Estado: `scripts/deploy.sh --status` · logs: `docker logs -f hermesweb` · volver atrás: `scripts/deploy.sh v0.1.0`.
- Cambiar la contraseña: `docker exec -it hermesweb node set-password.js`.

### Sin Docker

```bash
npm install
npm run set-password   # la primera vez (y para cambiarla)
npm start
```

Abre `http://127.0.0.1:7681` e ingresa la contraseña. La sesión del navegador dura 30 días
(`HERMES_SESSION_DAYS`). Cambiar la contraseña cierra todas las sesiones web abiertas
(no hace falta reiniciar el servidor).

### Desde una terminal: `hcw`
`bin/hcw` (enlazado en `~/.local/bin/hcw`) abre Claude en tu terminal como siempre, pero dentro
del tmux de HermesWeb, así la sesión también aparece en la web.

```bash
hcw                    # = claude, sesión nombrada según la carpeta
hcw -c                 # cualquier argumento de claude: -c, --resume, --model ...
hcw -n api --resume    # nombre explícito
hcw ls                 # listar sesiones
hcw a [nombre]         # engancharse a una existente (sin nombre: menú)
```
- Cerrar la ventana de la terminal **no** mata a Claude: retomala con `hcw a` o desde la web.
- Para soltar la terminal sin cerrar: `Ctrl+]` y luego `d` (el prefijo de tmux es `Ctrl+]`
  porque Claude usa `Ctrl+B`).
- Al salir de Claude (`/exit`) la sesión termina y desaparece del panel.

Las sesiones usan un servidor tmux propio (socket `~/.local/state/hermesweb/tmux.sock`); no se mezclan con tu tmux normal.

### Sesiones guardadas (pestaña «Guardadas» o `Alt+G`)
Catálogo de sesiones de Claude con nombre, título, carpeta, grupo, **reseña** e **historia**
(reemplaza a la sección de sesiones de ManagWorkDashboard).

- **+ Nueva**: el ID de la conversación (UUID) **se genera en el formulario**. El primer «Abrir»
  crea la conversación con `claude --session-id <uuid>` y los siguientes la retoman con
  `claude --resume <uuid>`; no hay que copiar IDs a mano. «Lanzador» = conversación nueva en cada
  apertura (con un prompt inicial). Se pueden agregar argumentos extra (`--model opus`).
- **▶ Abrir** lanza la sesión en una terminal de HermesWeb (tmux) en el directorio correcto
  —para `--resume` se usa el directorio donde nació la conversación, que es el único desde el que
  Claude la encuentra— y la muestra en el panel enfocado. Si ya está abierta, solo la enfoca.
- Estado de cada sesión: **● abierta** (corre ahora en una terminal), **sin iniciar** (su ID todavía
  no tiene conversación en esta máquina), **lanzador**. La actividad sale del transcript.
- **Descubrir**: conversaciones de `~/.claude/projects` que todavía no guardaste (título, carpeta,
  tamaño, costo); «Guardar» precarga el formulario.
- **★ Guardar** en la barra de terminales: guarda la terminal enfocada. Las conversaciones nuevas
  abiertas desde la web o con `hcw` reciben su UUID al nacer, así que se pueden guardar en cualquier
  momento (las abiertas con `-c`/`--continue` no, porque no se sabe cuál retoman).
- Ficha: reseña e historia en markdown, editables; fijar (★ arriba), archivar, copiar comando.
- Buscar (`/`) en nombre, título, carpeta, reseña e historia. Orden por grupo, actividad o nombre.

Desde la terminal o desde la propia sesión de Claude (la skill `/session-log` usa esto):
```bash
hcw saved [filtro] [-a]          # listar guardadas
hcw o <nombre>                   # abrir/retomar y engancharse
hcw show <nombre>                # reseña + historia
hcw register --name N --title T --group G   # guardar la sesión actual ($CLAUDE_CODE_SESSION_ID)
hcw summary <<'EOF' … EOF        # reseña de la sesión actual
hcw log -t "Título" -k decisión <<'EOF' … EOF   # entrada de historia
```
El CLI se autentica con `~/.config/hermesweb/api-token` (se crea al arrancar el servidor).
Datos en `~/.local/share/hermesweb/hermes.db` (SQLite). Importar desde ManagWorkDashboard
(solo lee su base; se puede repetir, no duplica): `npm run import-mwd`.

### Imágenes
Botón **🖼 Imágenes** (varias a la vez), `Ctrl+V` con una imagen en el portapapeles
(p. ej. captura con `Win+Shift+S`) o arrastrar archivos sobre la terminal. Se guardan en
`~/.cache/hermesweb/uploads/<sesión>/` y sus rutas se pegan en Claude, que las adjunta como
`[Image #N]`; luego escribes tu mensaje y Enter. PNG, JPG, GIF o WebP, máx 20 MB c/u.

### Paneles (ver varias sesiones a la vez)
Los botones de distribución (arriba a la derecha) reparten la pantalla: una sesión, dos apiladas,
dos lado a lado, tres (dos arriba y una abajo a todo el ancho) o grilla 2×2. Cada panel tiene su barra con nombre, carpeta y
tamaño; el panel enfocado se resalta y es el que reciben las acciones de la barra superior
(imágenes, renombrar, cerrar). Al elegir una sesión en la barra lateral, va al panel enfocado
(si ya está visible en otro panel, solo se enfoca). La × de un panel lo vacía sin cerrar la sesión.
La distribución se recuerda entre visitas.

### Atajos
En la web: botón **⌨ Atajos** (abajo a la izquierda), `Alt+H`, o `?` fuera de una terminal.

| Atajo | Acción |
|---|---|
| `Alt+1…9` | mostrar esa sesión en el panel enfocado |
| `Alt+N` | nueva sesión (en «Guardadas»: nueva sesión guardada) |
| `Alt+G` | alternar Terminales / Guardadas |
| `Alt+S` | contraer / mostrar la barra lateral |
| `Alt+Shift+1…5` | distribución: una · dos apiladas · dos lado a lado · tres (2 arriba + 1 abajo) · 2×2 |
| `Alt+Shift+flechas` | mover el foco al panel de al lado |
| `Alt+Z` (o doble clic en la barra del panel) | maximizar / restaurar el panel enfocado |
| Rueda del mouse | scroll por el historial (modo copia de tmux; `q` para salir) |
| `Shift+arrastrar`, `Ctrl+Shift+C` | seleccionar y copiar texto |

### Estados en la barra lateral
| Punto | Estado |
|---|---|
| amarillo pulsando | Claude trabajando (`esc to interrupt` en pantalla) |
| naranja pulsando | Claude pide permiso o una elección |
| verde | esperando tu mensaje |
| gris | solo shell (Claude terminó) |
| `●` junto al nombre | hubo actividad que no viste |

Hay notificaciones del navegador cuando una sesión termina de trabajar o pide permiso estando en otra pestaña
(se piden al primer clic).

## Configuración (variables de entorno)
| Variable | Default | |
|---|---|---|
| `PORT` | `7681` | |
| `HOST` | `127.0.0.1` | Usa la IP de Tailscale/VPN para acceder desde otros equipos. No lo expongas a internet. |
| `HERMES_SESSION_DAYS` | `30` | Duración de la sesión web |
| `HERMES_CONFIG_DIR` | `~/.config/hermesweb` | Dónde se guarda `auth.json` |
| `HERMES_TMUX_SOCKET` | `~/.local/state/hermesweb/tmux.sock` | Ruta del socket tmux (compartido entre host y contenedor) |
| `HERMES_HOST_LABEL` | hostname | Nombre de la máquina que muestra el panel |
| `HERMES_DATA_DIR` | `~/.local/share/hermesweb` | Base de datos de sesiones guardadas |
| `HERMES_UPLOAD_DIR` | `~/.cache/hermesweb/uploads` | Dónde se guardan las imágenes subidas |

## Releases y deploy

```bash
scripts/release.sh [patch|minor|major] -m "mensaje del commit"
```

Hace, en orden: commit de los cambios pendientes → sube la versión (`package.json`) y crea el tag
`vX.Y.Z` → push → release en GitHub con notas generadas de los commits → `scripts/deploy.sh vX.Y.Z`
en esta máquina. Muestra los commits incluidos y pide confirmación (`-y` para no preguntar,
`--no-deploy` para solo publicar).

En otra máquina (p. ej. el servidor HP): `git pull && scripts/deploy.sh`. GitHub Actions (`ci.yml`)
verifica en cada push que la imagen construye.

## Seguridad
Esta página equivale a acceso a una shell con tu usuario. Por eso:
- solo escucha en localhost por defecto;
- contraseña guardada como hash scrypt en `~/.config/hermesweb/auth.json` (permisos 600);
- cookie de sesión firmada con HMAC (HttpOnly, SameSite=Strict, Secure detrás de HTTPS);
- tras 5 intentos fallidos por IP, bloqueo creciente (30 s → 15 min); los fallos se registran en consola;
- rechaza peticiones y WebSockets con un Origin distinto, y la página no se puede embeber en iframes.

Si lo expones fuera de tu máquina, hazlo por Tailscale/VPN o detrás de un proxy HTTPS.
