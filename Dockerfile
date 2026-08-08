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
# Build identity, declared AFTER every COPY on purpose: an ARG invalidates the layer cache from the
# point it appears, and these two change on every single commit. Placed here they cost one tiny
# layer; placed at the top of the stage they would rebuild `npm ci` for every deployment.
#
# `/health/ready` returns APP_COMMIT and the deployment runner refuses to call an update successful
# until a ready response carries the commit it just deployed — so an image built without these args
# is an image that can never be the target of a recorded deployment. That is deliberate: a container
# that cannot prove what it is running must not be able to claim it.
ARG APP_COMMIT=unknown
ARG APP_BUILT_AT=
ENV APP_COMMIT=${APP_COMMIT}
ENV APP_BUILT_AT=${APP_BUILT_AT}
USER node
EXPOSE 3000
CMD ["node", "dist/index.js"]
