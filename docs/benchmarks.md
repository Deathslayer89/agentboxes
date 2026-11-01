# Benchmarks

Every number below names the machine it was measured on.

`npm run bench` measures through the HTTP API against a running server started with `POOL_SIZES=default:5`. Numbers from this machine on 2026-11-01:

Machine: 12th Gen Intel Core i7-12700H, 20 threads, 15 GB RAM, Linux 7.0.0, Docker 29.1.3, runsc release-20261026.0

| Measurement (HTTP round trip) | n | p50 ms | p95 ms | p99 ms |
|---|---|---|---|---|
| create from warm pool | 30 | 1.1 | 2.2 | 4.3 |
| create cold (no pool) | 10 | 129.9 | 154.2 | 154.2 |
| exec `print(2+2)` | 30 | 30.8 | 36.3 | 38.0 |

Five creates fired at the same time against a pool of five took 57 to 73 ms each, and a sixth create during the refill started cold at 141 ms. An idle sandbox holds about 16 MB of host memory with gVisor's sentry included, so about 63 idle sandboxes fit in 1 GB of RAM. A sandbox with a network allowlist starts cold in about 300 ms, since it also gets its own Docker network and the proxy joins it; with secrets, installing the CA adds another 300 ms.

The roadmap's kill criterion is gVisor being about 3x slower than runc on common tasks. Measured here on the systrap platform: Python startup 14 ms under gVisor against 11 ms under runc, `pip install requests` 2.0 s against 1.9 s, and `npm install express` (65 packages, node template) 1.8 s against 1.3 s. Syscall-heavy microbenchmarks (thousands of tiny files, process spawn loops) show 3 to 4x on systrap and about 2x on the KVM platform, which brings `npm install` to within 12% of runc.

Why `/workspace` is a tmpfs and not a disk volume: one Python process writing and reading 3000 small files took 214 ms on tmpfs under gVisor and 353 ms on a Docker volume under gVisor (85 ms and 62 ms under plain runc). Files in RAM are the faster choice under gVisor, and the size limit is real; the cost is that `diskMb` is memory.
