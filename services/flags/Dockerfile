
FROM node:26-alpine AS build
RUN npm install --global pnpm@10.34.9
WORKDIR /repo

COPY package.json pnpm-lock.yaml pnpm-workspace.yaml tsconfig.base.json ./
COPY services/flags/package.json services/flags/
RUN pnpm install --frozen-lockfile --filter @platform/flags

COPY services/flags/ services/flags/
RUN pnpm --filter @platform/flags build \
 && pnpm --filter @platform/flags deploy --prod /out

FROM node:26-alpine
ENV NODE_ENV=production \
    FLAGS_PORT=3005
WORKDIR /app

COPY --from=build /out ./

RUN rm -rf /usr/local/lib/node_modules/npm /usr/local/bin/npm /usr/local/bin/npx

USER node
EXPOSE 3005
CMD ["node", "dist/server.js"]
