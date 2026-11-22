#!/usr/bin/env bash
# Build the KatheryneQQ native addons into dist/native/.
# The memsync addon (poke cmd whitelist patch) requires gcc and the Node headers
# shipped with the running Node/nvm installation.
set -euo pipefail
cd "$(dirname "$0")/.."

NODE_BIN="$(command -v node || true)"
if [ -z "$NODE_BIN" ]; then
    echo "[build-native] node not found in PATH" >&2
    exit 1
fi
NODE_INC="$(dirname "$NODE_BIN")/../include/node"
if [ ! -f "$NODE_INC/node_api.h" ]; then
    echo "[build-native] node headers not found at $NODE_INC (install Node via nvm or a distro dev package)" >&2
    exit 1
fi

mkdir -p dist/native
gcc -shared -fPIC -O2 \
    -o dist/native/katheryne_memsync.node \
    src/native/memsync.c \
    -I"$NODE_INC" -ldl
echo "[build-native] dist/native/katheryne_memsync.node built"
