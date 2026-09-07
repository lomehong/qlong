#!/bin/sh
# 群龙(Qlong)安装脚本 — Linux/macOS
# 用法: curl -fsSL https://qlong.qianji.io/install.sh | sh -s -- --enroll-stdin
# token 经 stdin 传入(评审 I-16:不进 shell history / 进程参数)
set -e

ENROLL_TOKEN=""
UNINSTALL=0
RELEASE="${QLONG_VERSION:-latest}"
DIST_BASE="${QLONG_DIST_URL:-https://qlong.qianji.io}"
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

# 运行时检测:unix 产物为 node 单文件包(需 node ≥ 20)
if ! command -v node >/dev/null 2>&1; then
  echo ">>> 安装中止:未检测到 node,请先安装 Node.js >= 20(https://nodejs.org)" >&2
  exit 1
fi
NODE_MAJOR=$(node -p 'process.versions.node.split(".")[0]')
if [ "$NODE_MAJOR" -lt 20 ]; then
  echo ">>> 安装中止:Node.js 需 >= 20(当前 $(node -v))" >&2
  exit 1
fi

# enrollment(token 经 stdin,不进命令行)
if [ -n "$ENROLL_TOKEN" ]; then
  echo ">>> 注册入网..."
  echo "$ENROLL_TOKEN" | "$INSTALL_DIR/qlong" enroll --stdin
  echo ">>> 入网完成"
fi

# 服务化自启(纪要 §8.5:装完即在线/重启自动在线)
"$INSTALL_DIR/qlong" service install

# 装完即在线验收(I-22 清单)
echo ">>> 验收入网状态..."
"$INSTALL_DIR/qlong" status

echo ">>> 安装完成: $INSTALL_DIR/qlong"
echo ">>> 卸载: $INSTALL_DIR/qlong --uninstall(含凭证清除)"