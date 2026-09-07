#!/bin/sh
# 群龙(Qlong)安装脚本 — Linux/macOS
# 用法: curl -fsSL https://qlong.qianji.io/install.sh | sh -s -- --enroll-stdin
# token 经 stdin 传入(评审 I-16:不进 shell history / 进程参数)
set -e

ENROLL_TOKEN=""
while [ $# -gt 0 ]; do
  case "$1" in
    --enroll-stdin) shift; IFS= read -r ENROLL_TOKEN ;;
    *) echo "未知参数: $1"; exit 1 ;;
  esac
  shift
done

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
curl -fsSL "https://github.com/lomehong/qlong/releases/latest/download/qlong-$OS-$ARCH" -o "$INSTALL_DIR/qlong"
chmod +x "$INSTALL_DIR/qlong"

# enrollment(token 经 stdin,不进命令行)
if [ -n "$ENROLL_TOKEN" ]; then
  echo ">>> 注册入网..."
  echo "$ENROLL_TOKEN" | "$INSTALL_DIR/qlong" enroll --stdin
  echo ">>> 入网完成"
fi

echo ">>> 安装完成: $INSTALL_DIR/qlong"
echo ">>> 运行 qlong --help 查看用法"