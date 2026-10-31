#!/bin/bash
# Fetches Firecracker and a guest kernel, and builds the root filesystem image from python:3.12-slim.
# No sudo: the image is written with mkfs.ext4 -d. Everything lands in data/firecracker/.
set -euo pipefail
cd "$(dirname "$0")/.."
D=data/firecracker; mkdir -p "$D/bin" "$D/vms"
VERSION=${FIRECRACKER_VERSION:-v1.17.0}
ARCH=x86_64

if [ ! -x "$D/bin/firecracker" ]; then
  echo "downloading firecracker $VERSION"
  curl -sSL "https://github.com/firecracker-microvm/firecracker/releases/download/$VERSION/firecracker-$VERSION-$ARCH.tgz" | tar -xz -C "$D/bin" --strip-components=1 "release-$VERSION-$ARCH/firecracker-$VERSION-$ARCH"
  mv "$D/bin/firecracker-$VERSION-$ARCH" "$D/bin/firecracker"
fi

if [ ! -f "$D/vmlinux" ]; then
  # The newest 6.1 kernel from Firecracker's own CI bucket: this release series, or the newest series that has one.
  key=""
  for series in $(echo "$VERSION" | sed -E 's/^v([0-9]+\.[0-9]+).*/v\1/') v1.16 v1.15 v1.14 v1.13 v1.12; do
    key=$(curl -s "https://s3.amazonaws.com/spec.ccfc.min/?prefix=firecracker-ci/$series/$ARCH/vmlinux-6.1" | grep -o '<Key>[^<]*</Key>' | sed 's/<[^>]*>//g' | grep -v config | sort -V | tail -1 || true)
    [ -n "$key" ] && break
  done
  [ -n "$key" ] || { echo "no 6.1 CI kernel found in the Firecracker bucket"; exit 1; }
  echo "downloading kernel $key"
  curl -sSL "https://s3.amazonaws.com/spec.ccfc.min/$key" -o "$D/vmlinux"
fi

if [ ! -f "$D/rootfs.ext4" ]; then
  echo "building rootfs from python:3.12-slim"
  rm -rf "$D/rootfs-dir"; mkdir -p "$D/rootfs-dir"
  cid=$(docker create python:3.12-slim)
  docker export "$cid" | tar -x -C "$D/rootfs-dir" --exclude='dev/*' --no-same-owner --no-same-permissions 2>/dev/null || true
  docker rm "$cid" >/dev/null
  mkdir -p "$D/rootfs-dir/workspace" "$D/rootfs-dir/dev"
  install -m 755 firecracker/init.sh "$D/rootfs-dir/agentbox-init"
  truncate -s 1G "$D/rootfs.ext4"
  mkfs.ext4 -q -F -E root_owner=0:0 -d "$D/rootfs-dir" "$D/rootfs.ext4"
  rm -rf "$D/rootfs-dir"
fi
ls -la "$D/bin/firecracker" "$D/vmlinux" "$D/rootfs.ext4" | awk '{print $5, $9}'
echo "firecracker setup done"
