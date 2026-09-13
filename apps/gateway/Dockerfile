# syntax=docker/dockerfile:1
FROM node:26-alpine AS build
RUN corepack enable && corepack prepare pnpm@10.18.2 --activate
WORKDIR /repo
COPY . .
RUN pnpm install --frozen-lockfile && pnpm --filter firsthand-gateway... build

FROM node:26-alpine
ENV NODE_ENV=production
WORKDIR /repo
COPY --from=build /repo /repo
EXPOSE 8402
USER node
CMD ["node", "apps/gateway/dist/index.js"]
