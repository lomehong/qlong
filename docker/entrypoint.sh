#!/bin/sh
# 群龙中心容器入口:持久存储准入的部署便利层(语义见 docs/repair/CENTER-STORAGE.md)。
#
# - QLONG_STORAGE_MODE=create|open:显式指定;
#   缺省 auto:数据目录无 center.sqlite(全新卷)→ create;已有 → open。
#   卷被整体清空 = 新部署(无数据可丢);主库缺失但 sidecar 尚存属损坏场景,
#   由存储层拒绝(孤儿 sidecar/校验和不通过),绝不静默重建。
# - QLONG_LOCAL_FS_CONFIRMED 缺省 1:容器 overlay/本地卷即本地盘;
#   挂载 NFS/SMB/云同步盘的运维必须置 0,并另行显式确认——服务将拒绝启动。
# - QLONG_DATA_DIR 缺省 /data/qlong;平台持久卷请对齐挂载到该路径。
# 注:路径含空格时本入口不支持(请直接以完整命令行启动);镜像 CMD 参数(如 --dist-dir)原样透传。
set -e
DATA_DIR="${QLONG_DATA_DIR:-/data/qlong}"
MODE="${QLONG_STORAGE_MODE:-auto}"
# 存储层要求数据目录属主私有(0700,UNSAFE_PATH 防线);父目录若世界可写且无 sticky 位
# 也会被拒——尽力收紧父目录(非属主时失败不致命,由存储层最终裁决)。
mkdir -p "$DATA_DIR"
chmod 700 "$DATA_DIR"
chmod 700 "$(dirname "$DATA_DIR")" 2>/dev/null || true
if [ "$MODE" = "auto" ]; then
  if [ -f "$DATA_DIR/center.sqlite" ]; then
    MODE=open
  else
    MODE=create
  fi
fi
CONFIRM=""
if [ "${QLONG_LOCAL_FS_CONFIRMED:-1}" != "0" ]; then
  CONFIRM="--confirm-local-filesystem"
fi
ACL=""
if [ "$QLONG_WINDOWS_ACL_CONFIRMED" = "1" ]; then
  ACL="--confirm-windows-acl"
fi
# 以位置参数组合命令(不用字符串拼接:未加引号的展开不会剥掉字面引号,
# 上个版本曾把 "--dist-dir" 连引号一起传给 CLI,导致 dist-dir 失效)
set -- node dist/latest/qlong-cli.mjs server --data-dir "$DATA_DIR" --storage-mode "$MODE" $CONFIRM "$@"
if [ -n "$ACL" ]; then
  set -- "$@" $ACL
fi
if [ -n "$QLONG_DATA_BASE" ]; then
  set -- "$@" --data-base "$QLONG_DATA_BASE"
fi
exec "$@"