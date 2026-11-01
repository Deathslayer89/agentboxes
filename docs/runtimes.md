# Runtimes: gVisor platforms and Firecracker

gVisor on Docker is the default and runs anywhere. On a host with KVM there are two faster options.

## Firecracker runtime (optional, KVM hosts)

On a host with `/dev/kvm`, agentbox can run each sandbox as a Firecracker microVM instead of a gVisor container: a real guest kernel per sandbox, so a kernel bug inside a sandbox stays inside that VM. Same API, SDKs and MCP server; a second `SandboxRuntime` implementation. Setup needs no sudo and takes about a minute:

```bash
./firecracker/setup.sh           # downloads Firecracker and a prebuilt guest kernel, builds a rootfs image from python:3.12-slim
AGENTBOX_RUNTIME=firecracker npm start
```

The first start boots one VM to the guest agent's ready state and snapshots it (about 2 s). Every default-sized sandbox after that is restored from the snapshot in about 32 ms and seeded with fresh entropy; a custom size boots cold in about 620 ms. `/workspace` is a tmpfs inside the VM and the root filesystem is read-only, so VMs share one image. Commands and files travel over the VM's serial console, which is fine for commands and small files and slow for large transfers. Not supported on this runtime yet: templates, the network allowlist and secrets, live streaming of output (it arrives when the command ends), and adopting VMs after a server restart. The Firecracker jailer is not used. `npm run test:firecracker` runs its tests.

Measured on this machine through the HTTP API, median unless noted:

| | gVisor (`runsc-kvm`) | Firecracker |
|---|---|---|
| create from warm pool, p50 / p95 | 1.0 / 1.6 ms | 1.1 / 12.3 ms |
| create cold | 150 ms | 644 ms (kernel boot) |
| create from snapshot, no pool | not applicable | 32 ms |
| exec `print(2+2)` | 29 ms | 13 ms (one serial round trip instead of three Docker API calls) |
| idle sandbox host memory | 16 MB | 79 MB |

## gVisor's KVM platform

By default runsc uses the systrap platform, which works everywhere. On a machine with `/dev/kvm`, the KVM platform runs gVisor's kernel as a guest and cuts syscall overhead. Register it as a second runtime (needs sudo); agentbox uses it automatically when it is there:

```bash
sudo python3 - <<'PY'
import json; p="/etc/docker/daemon.json"; d=json.load(open(p))
d.setdefault("runtimes", {})["runsc-kvm"]={"path":"/usr/bin/runsc","runtimeArgs":["--platform=kvm"]}
json.dump(d, open(p,"w"), indent=4)
PY
sudo systemctl restart docker
docker run --rm --runtime=runsc-kvm alpine uname -a
npm start        # logs "runtime runsc-kvm"
```

Measured on this machine, one process writing and reading 3000 small files: 228 ms on systrap, 133 ms on KVM, 66 ms on runc. `npm install express`: 1945 ms, 1238 ms, 1110 ms. Python startup is unchanged at about 14 ms, and a cold sandbox start is about 20 ms slower on KVM (150 ms against 130 ms) because each sandbox sets up a small VM. `AGENTBOX_RUNTIME` accepts `auto` (the default), `runsc`, or a `runsc-` variant; there is no way to run on plain runc.
