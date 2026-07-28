FROM node:20-alpine AS build

WORKDIR /app

COPY package*.json ./

RUN npm ci

COPY . .

RUN npm run build

FROM node:20-alpine AS production

WORKDIR /app

COPY package*.json ./

RUN npm ci --only=production && npm cache clean --force

COPY --from=build /app/dist ./dist

RUN addgroup -S solargrid && adduser -S solargrid -G solargrid \
    && mkdir -p /app/data \
    && chown -R solargrid:solargrid /app

USER solargrid

CMD ["node", "dist/index.js"]
