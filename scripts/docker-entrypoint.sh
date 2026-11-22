#!/bin/sh
# KatheryneQQ container entrypoint.
#
# Expects:
#   /qq     (or $KATHERYNE_QQ_ROOT) — an extracted QQNT root containing
#           resources/app/package.json (e.g. AppImage --appimage-extract output)
#   /data   — persistent volume: config.json, QQ account records, logs
set -eu

QQ_ROOT="${KATHERYNE_QQ_ROOT:-/qq}"

if [ ! -f "$QQ_ROOT/resources/app/package.json" ]; then
    if [ "${KATHERYNE_AUTO_INSTALL:-0}" = "1" ]; then
        echo "[katheryne] no QQ at $QQ_ROOT — downloading the official Linux build to /data"
        node /opt/katheryne/installer/install.js --download --root-file /tmp/qqroot.txt
        QQ_ROOT="$(cat /tmp/qqroot.txt)"
        echo "[katheryne] using downloaded QQ at $QQ_ROOT"
    else
        echo "[katheryne] QQ installation not found at $QQ_ROOT" >&2
        echo "[katheryne] extract the QQ AppImage on the host first:" >&2
        echo "[katheryne]   ./QQ_3.2.35_x86_64.AppImage --appimage-extract" >&2
        echo "[katheryne] then mount the extracted root:" >&2
        echo "[katheryne]   -v \"\$PWD/squashfs-root\":/qq" >&2
        echo "[katheryne] or set KATHERYNE_AUTO_INSTALL=1 to download it instead" >&2
        exit 1
    fi
fi

mkdir -p "$(dirname "${KATHERYNE_CONFIG:-/data/config.json}")" /data

# Idempotent: copies the runtime into resources/app/katheryne and points
# resources/app/package.json "main" at katheryne/boot.js.
node /opt/katheryne/installer/install.js "$QQ_ROOT"

cd "$QQ_ROOT"
# Headless kernel driving: no renderer, no GPU (verified to boot without X).
# Extra args can be appended to override.
exec ./qq --no-sandbox --disable-gpu --headless "$@"
