
FROM node:26-alpine AS build
RUN npm install --global pnpm@10.34.9
WORKDIR /repo
ENV NEXT_TELEMETRY_DISABLED=1

COPY package.json pnpm-lock.yaml pnpm-workspace.yaml tsconfig.base.json ./
COPY packages/sdk/package.json packages/sdk/
COPY apps/demo-shop/package.json apps/demo-shop/

RUN pnpm install --frozen-lockfile --filter @secure-cloud/sdk
COPY packages/sdk/ packages/sdk/
RUN pnpm --filter @secure-cloud/sdk build
RUN pnpm install --frozen-lockfile --filter @platform/demo-shop

COPY apps/demo-shop/ apps/demo-shop/
RUN pnpm --filter @platform/demo-shop build

FROM node:26-alpine
ENV NODE_ENV=production \
    NEXT_TELEMETRY_DISABLED=1 \
    HOSTNAME=0.0.0.0 \
    PORT=3000
WORKDIR /app

COPY --from=build /repo/apps/demo-shop/.next/standalone ./
COPY --from=build /repo/apps/demo-shop/.next/static ./apps/demo-shop/.next/static

RUN rm -rf /usr/local/lib/node_modules/npm /usr/local/bin/npm /usr/local/bin/npx

USER node
EXPOSE 3000
CMD ["node", "apps/demo-shop/server.js"]
