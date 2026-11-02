#!/bin/sh
# Prepares a Linux host for agentbox: checks Docker, installs gVisor when it is missing, registers it with Docker as runsc (plus runsc-kvm when the host has /dev/kvm), and starts one container under it to prove it works.
# Usage: agentbox setup [--check]. With --check nothing is installed and the exit code says whether the host is ready.
set -eu

image=${AGENTBOX_IMAGE:-python:3.12-slim}
check_only=false
if [ "${1:-}" = "--check" ]; then check_only=true; fi

fail() { printf 'setup: %s\n' "$*" >&2; exit 1; }
# Every command that needs root is printed before it runs.
root() { printf '+ sudo %s\n' "$*"; sudo "$@"; }
registered() { docker info --format '{{range $name, $_ := .Runtimes}}{{$name}} {{end}}' | tr ' ' '\n' | grep -qx "$1"; }

[ "$(uname -s)" = Linux ] || fail "gVisor needs a Linux kernel; on macOS or Windows run agentbox inside a Linux VM"
command -v docker >/dev/null || fail "Docker is not installed: https://docs.docker.com/engine/install/"
docker info >/dev/null 2>&1 || fail "Docker is installed but not reachable: is the daemon running, and is your user in the docker group?"

missing=""
if ! registered runsc; then missing="runsc"; fi
if [ -e /dev/kvm ] && ! registered runsc-kvm; then missing="$missing runsc-kvm"; fi

if [ -z "$missing" ]; then
  echo "gVisor is registered with Docker"
elif $check_only; then
  fail "not registered with Docker:$missing. Run without --check to install"
else
  if ! command -v runsc >/dev/null; then
    if command -v apt-get >/dev/null; then
      # Debian and Ubuntu: gVisor's apt repository, so apt upgrade keeps it current.
      curl -fsSL https://gvisor.dev/archive.key | root gpg --dearmor --yes -o /usr/share/keyrings/gvisor-archive-keyring.gpg
      echo "deb [arch=$(dpkg --print-architecture) signed-by=/usr/share/keyrings/gvisor-archive-keyring.gpg] https://storage.googleapis.com/gvisor/releases release main" | root tee /etc/apt/sources.list.d/gvisor.list >/dev/null
      root apt-get update
      root apt-get install -y runsc
    else
      # Any other distribution: the release tarball (runsc, the containerd shim and the gvisor-bin/ helpers runsc starts), checksum verified.
      arch=$(uname -m)
      url="https://storage.googleapis.com/gvisor/releases/release/latest/$arch"
      tmp=$(mktemp -d)
      echo "downloading gVisor for $arch from $url"
      curl -fsSL -o "$tmp/gvisor.tar.bz2" "$url/gvisor.tar.bz2"
      curl -fsSL -o "$tmp/gvisor.tar.bz2.sha512" "$url/gvisor.tar.bz2.sha512"
      (cd "$tmp" && sha512sum -c gvisor.tar.bz2.sha512)
      root tar -xjf "$tmp/gvisor.tar.bz2" -C /usr/local/bin
      rm -rf "$tmp"
    fi
  fi
  runsc=$(command -v runsc)
  for name in $missing; do
    if [ "$name" = runsc ]; then root "$runsc" install; else root "$runsc" install --runtime=runsc-kvm -- --platform=kvm; fi
  done
  command -v systemctl >/dev/null || fail "restart Docker by hand so it loads the new runtimes, then run this again"
  root systemctl reload docker
  for name in $missing; do registered "$name" || fail "Docker does not list $name after the reload"; done
fi

echo "starting a container under runsc"
docker run --rm --runtime=runsc "$image" uname -r | grep -q gvisor || fail "a container under runsc did not report a gVisor kernel"
if registered runsc-kvm && ! docker run --rm --runtime=runsc-kvm "$image" true; then
  fail "runsc-kvm is registered but a container under it failed; remove it with \"sudo $(command -v runsc) uninstall --runtime=runsc-kvm\" and reload Docker, or set AGENTBOX_RUNTIME=runsc"
fi
echo "ready: run \"npx agentboxes serve\" (or \"agentbox serve\")"
