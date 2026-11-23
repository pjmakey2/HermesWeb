---
name: session-log
description: Guarda en HermesWeb la reseña y la historia de esta sesión de Claude Code. Usar cuando el usuario pide registrar/guardar la sesión, "session log", "guardá el avance", o al cerrar un bloque de trabajo que quiere dejar documentado.
---

# session-log

Empuja el estado de **esta** sesión al catálogo de sesiones guardadas de HermesWeb usando `hcw`.
`hcw` identifica la sesión con `$CLAUDE_CODE_SESSION_ID` y el directorio actual; si la sesión
todavía no está guardada, la registra sola.

## Qué enviar

1. **Reseña** (`hcw summary`): el estado *actual* de la sesión completa. Reemplaza a la anterior,
   así que debe valerse por sí sola. Markdown breve con:
   - **Objetivo**: para qué existe esta sesión.
   - **Estado actual**: qué funciona, qué está a medias.
   - **Decisiones clave** y su porqué.
   - **Próximos pasos**.
   - **Dónde mirar**: archivos, comandos o URLs importantes.

2. **Entrada de historia** (`hcw log`): solo lo hecho *desde la última entrada* (o desde el inicio
   si es la primera). Título de una línea + detalle en markdown. Tipos (`-k`): `avance` (por
   defecto), `decisión`, `problema`, `pendiente`, `nota`. Si hubo cosas de distinto tipo que
   conviene encontrar por separado, enviar varias entradas.

Escribir en español, concreto y sin relleno: nombres de archivos, comandos, números. Nada de
secretos (tokens, contraseñas, claves) en la reseña ni en la historia.

## Cómo enviarlo

```bash
hcw summary <<'EOF'
**Objetivo:** …

**Estado actual:** …

**Próximos pasos:**
- …
EOF

hcw log -t "Título corto de lo que se hizo" -k avance <<'EOF'
- …
EOF
```

Si el usuario dio un alias, título o grupo para la sesión (o la sesión se acaba de registrar con
un nombre por defecto y hay uno mejor evidente), aplicarlo:

```bash
hcw register --name mi_proyecto --title "Mi proyecto: descripción corta" --group Trabajo
```

Para ver lo ya guardado antes de escribir la entrada nueva: `hcw show "$CLAUDE_CODE_SESSION_ID"`.

Al terminar, mostrar al usuario la URL que imprime `hcw`. Si `hcw` avisa que no pudo conectar,
HermesWeb no está corriendo: indicar que se levanta con `cd ~/projects/HermesWeb && npm start`
y no reintentar en bucle.
