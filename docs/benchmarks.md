# Benchmarks

Every number below names the run it was measured on; nothing here is extrapolated.

`npm run bench` measures through the HTTP API against a running server started with `POOL_SIZES=default:5`. Measured on 2026-11-20 on this machine, runtime `runsc-kvm`, with 0.3.0 and 0.2.4 run in the same session so both saw the same load (four other containers paused, Supabase and ChromaDB still running):

Machine: 12th Gen Intel Core i7-12700H, 20 threads, 15 GB RAM, Linux 7.0.0, Docker 29.1.3, runsc release-20261102.0

| Measurement (HTTP round trip), p50 | 0.3.0 | 0.2.4 |
|---|---|---|
| create from warm pool | 4.1 to 4.9 ms | 4.4 to 5.0 ms |
| create cold (no pool) | 204 to 212 ms | 208 to 210 ms |
| exec `print(2+2)` | 70 to 83 ms | 70 to 72 ms |

An idle sandbox on 0.3.0 held about 16 MB of host memory with gVisor's sentry included, so about 64 fit in 1 GB of RAM.

The allowlist and secret costs are from the earlier run on 2026-11-01 (its runtime was not recorded): a sandbox with a network allowlist started cold in about 300 ms, since it also gets its own Docker network and the proxy joins it, and with secrets, installing the CA added about another 300 ms. In that same run, five creates fired at once against a pool of five took 57 to 73 ms each, and a sixth during the refill started cold at 141 ms.

The roadmap's kill criterion is gVisor being about 3x slower than runc on common tasks. Measured on this machine on gVisor's systrap platform: Python startup 14 ms under gVisor against 11 ms under runc, `pip install requests` 2.0 s against 1.9 s, and `npm install express` (65 packages, node template) 1.8 s against 1.3 s. Syscall-heavy microbenchmarks (thousands of tiny files, process spawn loops) show 3 to 4x on systrap and about 2x on the KVM platform, which brings `npm install` to within 12% of runc.

Why `/workspace` is a tmpfs and not a disk volume: one Python process writing and reading 3000 small files took 214 ms on tmpfs under gVisor and 353 ms on a Docker volume under gVisor (85 ms and 62 ms under plain runc). Files in RAM are the faster choice under gVisor, and the size limit is real; the cost is that `diskMb` is memory.
