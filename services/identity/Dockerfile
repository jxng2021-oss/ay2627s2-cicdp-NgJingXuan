
FROM node:26-alpine AS build
RUN npm install --global pnpm@10.34.9
WORKDIR /repo

COPY package.json pnpm-lock.yaml pnpm-workspace.yaml tsconfig.base.json ./
COPY services/identity/package.json services/identity/
RUN pnpm install --frozen-lockfile --filter @platform/identity

COPY services/identity/ services/identity/
RUN pnpm --filter @platform/identity build \
 && pnpm --filter @platform/identity deploy --prod /out

FROM node:26-alpine
ENV NODE_ENV=production \
    IDENTITY_PORT=3004
WORKDIR /app

COPY --from=build /out ./

RUN rm -rf /usr/local/lib/node_modules/npm /usr/local/bin/npm /usr/local/bin/npx

USER node
EXPOSE 3004
CMD ["node", "dist/server.js"]
