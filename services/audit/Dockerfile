
FROM node:26-alpine AS build
RUN npm install --global pnpm@10.34.9
WORKDIR /repo

COPY package.json pnpm-lock.yaml pnpm-workspace.yaml tsconfig.base.json ./
COPY services/audit/package.json services/audit/
RUN pnpm install --frozen-lockfile --filter @platform/audit

COPY services/audit/ services/audit/
RUN pnpm --filter @platform/audit build \
 && pnpm --filter @platform/audit deploy --prod /out

FROM node:26-alpine
ENV NODE_ENV=production \
    AUDIT_PORT=3003
WORKDIR /app

COPY --from=build /out ./

RUN rm -rf /usr/local/lib/node_modules/npm /usr/local/bin/npm /usr/local/bin/npx

USER node
EXPOSE 3003
CMD ["node", "dist/server.js"]
