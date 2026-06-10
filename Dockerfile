FROM node:22-alpine AS build

WORKDIR /app

COPY package.json package-lock.json tsconfig.json ./
COPY packages/server/package.json ./packages/server/package.json
COPY packages/admin/package.json ./packages/admin/package.json
COPY packages/shared/package.json ./packages/shared/package.json
RUN npm ci

COPY packages ./packages
RUN npm run build

FROM node:22-alpine AS runtime

WORKDIR /app
ENV NODE_ENV=production
ENV SUDO_LOG_PORT=8080
ENV SUDO_LOG_ADMIN_STATIC_DIR=/app/admin

COPY package.json package-lock.json ./
COPY packages/server/package.json ./packages/server/package.json
COPY packages/admin/package.json ./packages/admin/package.json
COPY packages/shared/package.json ./packages/shared/package.json
RUN npm ci --omit=dev

COPY --from=build /app/packages/server/dist ./packages/server/dist
COPY packages/admin/src ./admin

RUN mkdir -p /data/sudo-log/blobs

EXPOSE 8080
HEALTHCHECK --interval=30s --timeout=3s --start-period=5s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:8080/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

CMD ["node", "packages/server/dist/index.js"]
