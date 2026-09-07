# 群龙(Qlong)创空间/容器部署镜像:单端口服务
# registry API(/v1)+ 书坊(/install /install.sh /releases)+ 控制台(/)+ 网关 ws(/gateway)
FROM node:22-alpine AS build
WORKDIR /app
RUN corepack enable
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml tsconfig.base.json ./
COPY packages ./packages
COPY scripts ./scripts
RUN pnpm install --no-frozen-lockfile
RUN node scripts/package.mjs

FROM node:22-alpine
WORKDIR /app
ENV NODE_ENV=production
ENV PORT=7860
COPY --from=build /app/dist-release ./dist
EXPOSE 7860
CMD ["node", "dist/latest/qlong-cli.mjs", "server", "--dist-dir", "dist"]
