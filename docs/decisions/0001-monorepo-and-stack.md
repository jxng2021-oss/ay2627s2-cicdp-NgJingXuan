# 0001: Monorepo, TypeScript with Fastify, and Next.js for the frontend

- Status: Accepted
- Date: 2026-11-03

## Context

The platform will have several services (API gateway, storage, later a secrets
manager), a web frontend and shared infrastructure code. We are a small team
starting from scratch and want to move quickly without the services drifting
apart.

## Decision

**One repository with pnpm workspaces.** Every service, the end-to-end tests
and later the frontend and infrastructure live together. A change that spans
the gateway and storage (or an API and its frontend) is one commit and one
review. Tooling, TypeScript settings and lint rules are shared, and the single
lockfile pins every dependency. pnpm is fast, saves disk space and is strict
about undeclared dependencies.

**TypeScript on Node.js with Fastify for backend services.** One language
across backend and frontend means shared knowledge and, later, shared types.
Strict TypeScript catches many mistakes before runtime. Node.js handles
streaming I/O well, which matters for file storage. Fastify is fast, actively
maintained, has first-class TypeScript types, and includes request logging,
plugins and an in-process `inject()` helper that makes route testing easy.

**Next.js with TypeScript for the future frontend.** It is the most widely used
React framework, supports both server-rendered and static pages, and keeps the
frontend in the same language and repository as the backend. It is not built
yet.

## Consequences

- One CI pipeline will need to build and test only the parts that changed;
  pnpm's `--filter` makes that possible.
- Each service still has its own Dockerfile and can be deployed separately.
- If a service ever needs a different language, it can still live in this
  repository, outside the pnpm workspace.
