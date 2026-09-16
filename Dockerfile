# 群龙(Qlong)创空间/容器部署镜像:单端口服务
# registry API(/v1)+ 书坊(/install /install.sh /releases)+ 控制台(/)+ 网关 ws(/gateway)
# 持久存储准入由 docker/entrypoint.sh 显式落位(语义见 docs/repair/CENTER-STORAGE.md):
# - QLONG_DATA_DIR(默认 /data/qlong):平台持久卷请对齐挂载到该路径,否则数据随容器生命周期
# - QLONG_STORAGE_MODE=auto(缺省):全新目录 create,已有 center.sqlite 则 open;可显式覆盖
# - QLONG_LOCAL_FS_CONFIRMED=1(缺省):容器 overlay/本地卷即本地盘;
#   挂载 NFS/SMB/云同步盘必须置 0 并另行显式确认——服务将拒绝启动
FROM node:24-alpine AS build
WORKDIR /app
RUN corepack enable
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml tsconfig.base.json ./
COPY packages ./packages
COPY scripts ./scripts
RUN pnpm install --no-frozen-lockfile
RUN node scripts/package.mjs

FROM node:24-alpine
WORKDIR /app
ENV NODE_ENV=production
ENV PORT=7860
ENV QLONG_DATA_DIR=/data/qlong
ENV QLONG_STORAGE_MODE=auto
ENV QLONG_LOCAL_FS_CONFIRMED=1
COPY --from=build /app/dist-release ./dist
COPY docker/entrypoint.sh /app/docker-entrypoint.sh
RUN chmod +x /app/docker-entrypoint.sh
EXPOSE 7860
ENTRYPOINT ["/app/docker-entrypoint.sh"]
CMD ["--dist-dir", "dist"]
