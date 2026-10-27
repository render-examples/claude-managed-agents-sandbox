#!/bin/bash
set -euo pipefail

readonly VERSION="2.1.0"
readonly RELEASE_BASE="https://github.com/anthropics/anthropic-cli/releases/download/v${VERSION}"
readonly INSTALL_DIR="/workspace/.managed-agent/bin"
readonly ARCHIVE="/tmp/ant.tar.gz"

case "$(uname -m)" in
  x86_64|amd64)
    arch="amd64"
    checksum="32d15351a159b0b882aa42e1a47183b3a3d1fec1056d1a874e324bc582dd87b9"
    ;;
  aarch64|arm64)
    arch="arm64"
    checksum="5f91d98884a8c15ca9f197a900128c66138fb06dcf900d4ee744fdd31dfdb687"
    ;;
  *)
    echo "Unsupported Linux architecture: $(uname -m)" >&2
    exit 1
    ;;
esac

# The worker runs its bash tool in a PTY, and Render Sandboxes boot without devpts.
if ! grep -qs ' /dev/pts devpts ' /proc/mounts; then
  mkdir -p /dev/pts
  mount -t devpts devpts /dev/pts -o newinstance,ptmxmode=0666,mode=0620
  ln -sf /dev/pts/ptmx /dev/ptmx
fi

mkdir -p "$INSTALL_DIR"
curl --fail --silent --show-error --location \
  "${RELEASE_BASE}/ant_${VERSION}_linux_${arch}.tar.gz" \
  --output "$ARCHIVE"
printf '%s  %s\n' "$checksum" "$ARCHIVE" | sha256sum --check -
tar -xzf "$ARCHIVE" -C "$INSTALL_DIR" ant
chmod 0755 "$INSTALL_DIR/ant"
rm -f "$ARCHIVE"
"$INSTALL_DIR/ant" --version
