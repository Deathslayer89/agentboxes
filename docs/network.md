# Network allowlist and secrets

A sandbox has no network unless its creator lists hosts, and secrets are added by the proxy on the way out, never inside.

## Network: off by default, an allowlist per sandbox

A sandbox has no network unless the request names hosts it may reach:

```bash
curl -s -X POST localhost:7788/sandboxes -d '{"allowHosts":["pypi.org","files.pythonhosted.org"]}'
curl -s -X POST localhost:7788/sandboxes/sbx_.../exec -d '{"cmd":["pip","download","--no-deps","-d","/tmp/dl","six"],"timeoutMs":120000}'
curl -s localhost:7788/sandboxes/sbx_.../egress-log
# {"allowHosts":["pypi.org","files.pythonhosted.org"],"denied":[{"at":"...","method":"CONNECT","host":"example.com","port":443,"reason":"host not in allowHosts"}]}
```

How it works: such a sandbox gets its own internal Docker network with an isolated gateway (Docker 28+), so the only thing it can reach is the egress proxy container, not the internet and not the host. Inside, `HTTP_PROXY` and `HTTPS_PROXY` point at the proxy with a token that identifies the sandbox. The proxy lets allowlisted hosts through and refuses everything else with a 403, recording each refusal in the egress log. Hosts that resolve to loopback, link-local (the cloud metadata address `169.254.169.254`), private or multicast addresses are refused even when allowlisted. `*.example.com` in the allowlist matches subdomains. A bare host allows ports 80 and 443; `db.example.com:5432` allows one other port. The proxy's control API listens only on Docker's default bridge, which sandbox networks cannot reach, and each sandbox's proxy token is bound to its own network's subnet, so a token that leaks (into a log, say) is refused from anywhere else and the refusal shows up in the egress log.

pip, curl, git, npm, and Python's `urllib` and `requests` honour the proxy variables; `NO_PROXY` keeps the sandbox's own loopback off the proxy, so a dev server or a test server inside keeps working. Node's built-in `fetch` only does so with `NODE_USE_ENV_PROXY=1`, which the node template sets (verified on Node 22; undici prints an "experimental" warning). Installing packages at run time this way is the slow path; use a template for anything you need more than once.

A sandbox with a network always starts cold, since pooled containers have no network. The proxy container (`agentbox-egress-proxy`) is built from `proxy/` on the first start and runs under runc, not gVisor, because gVisor does not pick up networks connected after start; it runs as a non-root user with all capabilities dropped, a read-only root and a 256 MB limit.

## Secrets that never enter the sandbox

```bash
OPENAI_API_KEY=sk-... npm start
curl -s -X POST localhost:7788/sandboxes -d '{"secrets":{"api.openai.com":"OPENAI_API_KEY"}}'
curl -s -X POST localhost:7788/sandboxes -d '{"secrets":{"api.anthropic.com":{"env":"ANTHROPIC_API_KEY","header":"x-api-key"}}}'
```

The value of `OPENAI_API_KEY` is read from the server's environment and given only to the proxy. The host is allowlisted automatically. For that host the proxy terminates TLS with a certificate from its own CA, sets `Authorization: Bearer <value>` in place of whatever the sandbox sent, and opens its own TLS connection upstream. The object form names another header and an optional `prefix` for the value (none by default), which is what Anthropic's `x-api-key` needs. The CA is written into the sandbox at `/tmp/agentbox` and named by `SSL_CERT_FILE`, `REQUESTS_CA_BUNDLE`, `CURL_CA_BUNDLE`, `GIT_SSL_CAINFO`, `PIP_CERT` and `NODE_EXTRA_CA_CERTS`, alongside the image's normal bundle. Hosts without a secret are plain tunnels the proxy cannot read. The integration test for this fetches `https://httpbin.org/headers` from inside a sandbox, sees the secret in the echoed headers, and greps the sandbox's environment and filesystem to confirm the value is not there.
