# HermesWeb en Docker: el contenedor corre SOLO la web (Node) y actúa como cliente tmux.
# El servidor tmux y las sesiones de claude corren en el HOST (socket compartido), así claude
# sigue usando tus proyectos, herramientas y ~/.claude. Ver docker-compose.yml.
# Misma distro que el host (Debian 13) → misma versión de tmux (el protocolo cliente/servidor
# tiene que coincidir).

FROM node:24-trixie-slim AS deps
RUN apt-get update && apt-get install -y --no-install-recommends python3 make g++ \
 && rm -rf /var/lib/apt/lists/*
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev

FROM node:24-trixie-slim
RUN apt-get update && apt-get install -y --no-install-recommends tmux tini git \
 && rm -rf /var/lib/apt/lists/*
ENV NODE_ENV=production LANG=C.UTF-8 HERMES_IN_DOCKER=1 HOST=0.0.0.0
WORKDIR /app
COPY --from=deps /app/node_modules ./node_modules
COPY . .
ARG VERSION=dev
LABEL org.opencontainers.image.source="https://github.com/pjmakey2/HermesWeb" \
      org.opencontainers.image.version="$VERSION"
ENV HERMES_VERSION=$VERSION
EXPOSE 7681
ENTRYPOINT ["tini", "--"]
CMD ["node", "--disable-warning=ExperimentalWarning", "server.js"]
