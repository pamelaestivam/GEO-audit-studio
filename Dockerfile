# One always-on container: the Express API and the built frontend in a single
# process. State lives in SQLite under DATA_DIR, so mount a persistent volume
# there (see docs/DEPLOYMENT.md). Runs on any host that runs a container
# (Fly.io, Railway, a VPS, Cloud Run with a volume, ...).
#
# Verified by CI on every push: the `docker` job in .github/workflows/ci.yml
# builds this image, runs it with a volume, and runs scripts/smoke.mjs against
# the container. (It could not be built in the authoring environment, which had
# the Docker CLI but no daemon.)

FROM node:22-slim AS build
WORKDIR /app
COPY package.json package-lock.json ./
# Dev dependencies are needed to build (esbuild, typescript); they are pruned below.
RUN npm ci
COPY . .
RUN npm run build && npm prune --omit=dev

FROM node:22-slim
ENV NODE_ENV=production \
    PORT=3000 \
    DATA_DIR=/data
WORKDIR /app
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/dist ./dist
COPY package.json ./
# `docker exec <container> node scripts/backup.mjs` - the slim image has no sqlite3 CLI.
COPY scripts/backup.mjs ./scripts/backup.mjs
# The data directory must be writable by the runtime user.
RUN mkdir -p /data && chown -R node:node /data /app
USER node
VOLUME ["/data"]
EXPOSE 3000
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+process.env.PORT+'/api/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
CMD ["node", "dist/server.cjs"]
