
FROM node:26-alpine AS build
RUN npm install --global pnpm@10.34.9
WORKDIR /repo

COPY package.json pnpm-lock.yaml pnpm-workspace.yaml tsconfig.base.json ./
COPY services/secrets/package.json services/secrets/
RUN pnpm install --frozen-lockfile --filter @platform/secrets

COPY services/secrets/ services/secrets/
RUN pnpm --filter @platform/secrets build \
 && pnpm --filter @platform/secrets deploy --prod /out

FROM node:26-alpine
ENV NODE_ENV=production \
    SECRETS_PORT=3002
WORKDIR /app

COPY --from=build /out ./

RUN rm -rf /usr/local/lib/node_modules/npm /usr/local/bin/npm /usr/local/bin/npx

USER node
EXPOSE 3002
CMD ["node", "dist/server.js"]
