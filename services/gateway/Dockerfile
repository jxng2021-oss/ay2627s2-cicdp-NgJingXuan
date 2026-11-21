
FROM node:26-alpine AS build
RUN npm install --global pnpm@10.34.9
WORKDIR /repo

COPY package.json pnpm-lock.yaml pnpm-workspace.yaml tsconfig.base.json ./
COPY services/gateway/package.json services/gateway/
RUN pnpm install --frozen-lockfile --filter @platform/gateway

COPY services/gateway/ services/gateway/
RUN pnpm --filter @platform/gateway build \
 && pnpm --filter @platform/gateway deploy --prod /out

FROM node:26-alpine
ENV NODE_ENV=production \
    GATEWAY_PORT=8080
WORKDIR /app

COPY --from=build /out ./

RUN rm -rf /usr/local/lib/node_modules/npm /usr/local/bin/npm /usr/local/bin/npx

USER node
EXPOSE 8080
CMD ["node", "dist/server.js"]
