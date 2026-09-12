# Продакшн-образ: один Node-процесс отдаёт и API, и собранный фронт.
# Отдельный статик-хостинг не нужен — одно происхождение, никакого CORS.

# ---------- сборка ----------
FROM node:24-alpine AS build
WORKDIR /app

# Сначала только манифесты — тогда слой с npm ci переиспользуется,
# пока зависимости не менялись.
COPY package.json package-lock.json ./
COPY packages/shared/package.json packages/shared/
COPY packages/market/package.json packages/market/
COPY apps/api/package.json apps/api/
COPY apps/web/package.json apps/web/
RUN npm ci

COPY tsconfig.base.json ./
COPY packages packages
COPY apps apps
RUN npm run build

# ---------- рантайм ----------
FROM node:24-alpine AS runtime
WORKDIR /app
ENV NODE_ENV=production

# Только продакшн-зависимости: fastify с плагинами, ccxt и драйвер postgres.
# @cs/shared и @cs/market в рантайме не нужны — esbuild вшил их в bundle.
COPY package.json package-lock.json ./
COPY packages/shared/package.json packages/shared/
COPY packages/market/package.json packages/market/
COPY apps/api/package.json apps/api/
COPY apps/web/package.json apps/web/
RUN npm ci --omit=dev && npm cache clean --force

COPY --from=build /app/apps/api/dist apps/api/dist
COPY --from=build /app/apps/web/dist apps/web/dist

# Не root: если процесс скомпрометируют, он не хозяин контейнера.
USER node

EXPOSE 8787
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||8787)+'/api/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

CMD ["node", "apps/api/dist/index.js"]
