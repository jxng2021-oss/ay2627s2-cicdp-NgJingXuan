
FROM node:26-alpine AS build
RUN npm install --global pnpm@10.34.9
WORKDIR /repo

COPY package.json pnpm-lock.yaml pnpm-workspace.yaml tsconfig.base.json ./
COPY tools/mock-upstream/package.json tools/mock-upstream/
RUN pnpm install --frozen-lockfile --filter @platform/mock-upstream

COPY tools/mock-upstream/ tools/mock-upstream/
RUN pnpm --filter @platform/mock-upstream build \
 && pnpm --filter @platform/mock-upstream deploy --prod /out

FROM node:26-alpine
ENV NODE_ENV=production \
    PORT=4000
WORKDIR /app

COPY --from=build /out ./

RUN rm -rf /usr/local/lib/node_modules/npm /usr/local/bin/npm /usr/local/bin/npx

USER node
EXPOSE 4000
CMD ["node", "dist/server.js"]
