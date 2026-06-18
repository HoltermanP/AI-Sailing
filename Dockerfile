# AI-Sailing — productie-image. Geen build-stap nodig (plain Node + statische assets).
FROM node:20-slim

ENV NODE_ENV=production
WORKDIR /app

# Alleen runtime-dependencies installeren (express); devDeps (eslint) overslaan.
COPY package.json package-lock.json ./
RUN npm ci --omit=dev

COPY server ./server
COPY public ./public

EXPOSE 3000
# Health-check tegen het /health endpoint.
HEALTHCHECK --interval=30s --timeout=5s --start-period=5s \
  CMD node -e "fetch('http://localhost:'+(process.env.PORT||3000)+'/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

CMD ["node", "server/index.js"]
