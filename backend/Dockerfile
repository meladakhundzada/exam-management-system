# University Examination Department Management System — backend image.
# Node 20, production install (all deps: dotenv is required by server.js),
# runs as a non-root user, listens on $PORT (Render/Docker set it).
FROM node:20-alpine

WORKDIR /app

# Install dependencies first so this layer is cached until package files change.
COPY package.json package-lock.json ./
RUN npm ci --no-audit --no-fund

# Copy application code (database migrations live one level up in the repo
# and are applied separately — see docs/DEPLOY_GUIDE.md, they are NOT
# copied into this image).
COPY src ./src

USER node
EXPOSE 5000
ENV NODE_ENV=production
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD wget -qO- http://127.0.0.1:${PORT:-5000}/api/health || exit 1
CMD ["node", "src/server.js"]
