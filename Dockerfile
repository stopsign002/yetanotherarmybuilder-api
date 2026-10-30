FROM node:22-bookworm-slim AS build
WORKDIR /app
RUN apt-get update \
 && apt-get install -y --no-install-recommends python3 build-essential ca-certificates \
 && rm -rf /var/lib/apt/lists/*
# Reproducible installs: npm ci installs exactly what package-lock.json pins
# and fails if it is out of step with package.json. To change a dependency,
# edit package.json, regenerate the lock (api/CLAUDE.md "Dependencies"), and
# commit both.
COPY package.json package-lock.json ./
RUN npm ci --omit=dev

FROM node:22-bookworm-slim
WORKDIR /app
ENV NODE_ENV=production
COPY --from=build /app/node_modules ./node_modules
COPY . .
USER node
EXPOSE 3000
CMD ["node", "server.js"]
