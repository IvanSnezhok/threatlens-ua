FROM node:22-alpine AS build
WORKDIR /app
COPY package*.json ./
RUN apk add --no-cache --virtual .build-deps python3 make g++ \
    && npm ci \
    && apk del .build-deps
COPY tsconfig.json ./
COPY src ./src
COPY web ./web
COPY public ./public
RUN npm run build

FROM node:22-alpine AS runtime
WORKDIR /app
ENV NODE_ENV=production
RUN apk add --no-cache curl
COPY package*.json ./
RUN apk add --no-cache --virtual .build-deps python3 make g++ \
    && npm ci --omit=dev \
    && apk del .build-deps
COPY --from=build /app/dist ./dist
COPY --from=build /app/public ./public
COPY migrations ./migrations
COPY data/map ./data/map
USER node
EXPOSE 3000
CMD ["node", "dist/index.js"]
