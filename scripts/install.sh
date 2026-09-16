#!/bin/sh
# 群龙(Qlong)安装脚本 — Linux/macOS
# 用法(两步式:token 经 stdin 传给脚本,评审 I-16 不进 history):
#   curl -fsSL https://lomehong-qlong.ms.show/install.sh -o /tmp/qlong-install.sh
#   echo "<邀请码>" | sh /tmp/qlong-install.sh --enroll-stdin [--version vX.Y.Z]
# 卸载: sh /tmp/qlong-install.sh --uninstall
set -e

ENROLL_TOKEN=""
UNINSTALL=0
RELEASE="${QLONG_VERSION:-latest}"
DIST_BASE="${QLONG_DIST_URL:-https://lomehong-qlong.ms.show}"
while [ $# -gt 0 ]; do
  case "$1" in
    --enroll-stdin) shift; IFS= read -r ENROLL_TOKEN ;;
    --uninstall) UNINSTALL=1 ;;
    --version) shift; RELEASE="$1" ;;
    *) echo "未知参数: $1"; exit 1 ;;
  esac
  shift
done

# 卸载:停自启 → 删二进制 → 清凭证(纪要 §8.5:卸载与凭证清除)
if [ "$UNINSTALL" = "1" ]; then
  BIN="$HOME/.local/bin/qlong"
  [ -x "$BIN" ] || BIN="/usr/local/bin/qlong"
  "$BIN" service uninstall 2>/dev/null || true
  rm -f "$BIN"
  rm -rf "$HOME/.qlong"
  echo ">>> 已卸载:自启解除、二进制与本地凭证(~/.qlong)已清除"
  exit 0
fi

# 检测平台
OS="$(uname -s | tr '[:upper:]' '[:lower:]')"
ARCH="$(uname -m)"
case "$ARCH" in
  x86_64) ARCH="x64" ;;
  aarch64|arm64) ARCH="arm64" ;;
  *) echo "不支持的架构: $ARCH"; exit 1 ;;
esac

echo ">>> 群龙安装: $OS/$ARCH"

# 下载二进制(发布物应有签名校验,评审 I-16)
INSTALL_DIR="/usr/local/bin"
if [ "$(id -u)" -ne 0 ]; then
  INSTALL_DIR="$HOME/.local/bin"
  mkdir -p "$INSTALL_DIR"
fi

echo ">>> 下载 qlong..."
curl -fsSL "$DIST_BASE/releases/$RELEASE/qlong-$OS-$ARCH" -o "$INSTALL_DIR/qlong"

# 发布物校验(评审 I-16):SHA256SUMS.txt 比对,不匹配即中止
echo ">>> 校验发布物..."
curl -fsSL "$DIST_BASE/releases/$RELEASE/SHA256SUMS.txt" -o "$INSTALL_DIR/SHA256SUMS.txt"
if command -v sha256sum >/dev/null 2>&1; then
  EXPECTED=$(grep "  qlong-$OS-$ARCH\$" "$INSTALL_DIR/SHA256SUMS.txt" | awk '{print $1}')
elif command -v shasum >/dev/null 2>&1; then
  EXPECTED=$(grep "  qlong-$OS-$ARCH\$" "$INSTALL_DIR/SHA256SUMS.txt" | awk '{print $1}')
else
  EXPECTED=""
  echo ">>> 警告:未找到 sha256sum/shasum,跳过校验和验证"
fi
if [ -n "$EXPECTED" ]; then
  ACTUAL=$(sha256sum "$INSTALL_DIR/qlong" 2>/dev/null | awk '{print $1}' || shasum -a 256 "$INSTALL_DIR/qlong" | awk '{print $1}')
  if [ "$ACTUAL" != "$EXPECTED" ]; then
    echo ">>> 安装中止:发布物校验和不匹配(预期 $EXPECTED,实际 $ACTUAL)" >&2
    rm -f "$INSTALL_DIR/qlong" "$INSTALL_DIR/SHA256SUMS.txt"
    exit 1
  fi
  echo ">>> 校验通过"
fi
rm -f "$INSTALL_DIR/SHA256SUMS.txt"
chmod +x "$INSTALL_DIR/qlong"

# 运行时检测:内置 SQLite 需要 Node.js >= 24
if ! command -v node >/dev/null 2>&1; then
  echo ">>> 安装中止:未检测到 node,请先安装 Node.js >= 24(https://nodejs.org)" >&2
  exit 1
fi
NODE_MAJOR=$(node -p 'process.versions.node.split(".")[0]')
if [ "$NODE_MAJOR" -lt 24 ]; then
  echo ">>> 安装中止:Node.js 需 >= 24(当前 $(node -v))" >&2
  exit 1
fi

# enrollment(token 经 stdin;中心地址随分发源走:装自哪个中心就入哪个网)
GW_BASE="$DIST_BASE"
case "$GW_BASE" in
  https://*) GW_BASE="wss://${GW_BASE#https://}" ;;
  http://*) GW_BASE="ws://${GW_BASE#http://}" ;;
esac
GATEWAY_URL="${QLONG_GATEWAY_URL:-$GW_BASE/gateway}"
if [ -n "$ENROLL_TOKEN" ]; then
  echo ">>> 注册入网..."
  echo "$ENROLL_TOKEN" | "$INSTALL_DIR/qlong" enroll --stdin --registry "$DIST_BASE" --gateway "$GATEWAY_URL"
  echo ">>> 入网完成"
fi

# 服务化自启(纪要 §8.5:装完即在线/重启自动在线)。
# 持久节点拒绝隐式启动:自启必须显式准入(open + 本地文件系统确认);
# create 不能注册为自启(重启即 DATABASE_EXISTS 失败循环)——首次创建须手动完成。
SERVICE_ARGS=""
if [ -n "$QLONG_STORAGE_MODE" ] && [ "$QLONG_LOCAL_FS_CONFIRMED" = "1" ]; then
  if [ "$QLONG_STORAGE_MODE" != "open" ]; then
    echo ">>> 跳过自启注册:QLONG_STORAGE_MODE=$QLONG_STORAGE_MODE;自启必须 open"
    echo "    首次手动执行: qlong run --storage-mode create --confirm-local-filesystem"
    echo "    完成后以 QLONG_STORAGE_MODE=open 重跑安装即可注册自启"
  else
    [ -n "$QLONG_DATA_DIR" ] && SERVICE_ARGS="$SERVICE_ARGS --data-dir $QLONG_DATA_DIR"
    [ -n "$QLONG_DATA_BASE" ] && SERVICE_ARGS="$SERVICE_ARGS --data-base $QLONG_DATA_BASE"
    SERVICE_ARGS="$SERVICE_ARGS --storage-mode open --confirm-local-filesystem"
    [ "$QLONG_WINDOWS_ACL_CONFIRMED" = "1" ] && SERVICE_ARGS="$SERVICE_ARGS --confirm-windows-acl"
    # shellcheck disable=SC2086
    "$INSTALL_DIR/qlong" service install $SERVICE_ARGS
  fi
else
  echo ">>> 跳过自启注册:未配置持久存储准入(QLONG_STORAGE_MODE=open + QLONG_LOCAL_FS_CONFIRMED=1)"
  echo "    数据目录须在本机本地磁盘(勿用 NFS/SMB/云同步盘);配置后重跑安装,"
  echo "    或手动: qlong service install --storage-mode open --confirm-local-filesystem"
fi

# 装完即在线验收(I-22 清单)
echo ">>> 验收入网状态..."
"$INSTALL_DIR/qlong" status

echo ">>> 安装完成: $INSTALL_DIR/qlong"
echo ">>> 卸载: $INSTALL_DIR/qlong --uninstall(含凭证清除)"
