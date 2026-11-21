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

How it works: such a sandbox gets its own internal Docker network, with its own /24 subnet and an isolated gateway, so the proxy can join it at a fixed address on Docker 28 as well as 29, and the only thing the sandbox can reach is the egress proxy container, not the internet and not the host. Each sandbox's /24 is taken from `AGENTBOX_NETWORK_POOL` (default `10.201.0.0/16`, one /24 per networked sandbox); set it to another /16 when `10.201` clashes with a host or VPN route. Inside, `HTTP_PROXY` and `HTTPS_PROXY` point at the proxy with a token that identifies the sandbox. The proxy lets allowlisted hosts through and refuses everything else with a 403, recording each refusal in the egress log. Hosts that resolve to loopback, link-local (the cloud metadata address `169.254.169.254`), private or multicast addresses are refused even when allowlisted. `*.example.com` in the allowlist matches subdomains. A bare host allows ports 80 and 443; `db.example.com:5432` allows one other port. The proxy's control API listens only on Docker's default bridge, which sandbox networks cannot reach, and each sandbox's proxy token is bound to its own network's subnet, so a token that leaks (into a log, say) is refused from anywhere else and the refusal shows up in the egress log.

pip, curl, git, npm, and Python's `urllib` and `requests` honour the proxy variables; `NO_PROXY` keeps the sandbox's own loopback off the proxy, so a dev server or a test server inside keeps working. Node's built-in `fetch` only does so with `NODE_USE_ENV_PROXY=1`, which the node template sets (verified on Node 22; undici prints an "experimental" warning). Installing packages at run time this way is the slow path; use a template for anything you need more than once.

A sandbox with a network always starts cold, since pooled containers have no network. The proxy container (`agentbox-egress-proxy`) is built from `proxy/` on the first start and runs under runc, not gVisor, because gVisor does not pick up networks connected after start; it runs as a non-root user with all capabilities dropped, a read-only root and a 256 MB limit.

## Secrets that never enter the sandbox

The operator declares the secrets, binding each host to one environment variable, in `AGENTBOX_SECRETS`. A create request then names which of those hosts a sandbox should get; it cannot name an environment variable itself.

```bash
OPENAI_API_KEY=sk-... ANTHROPIC_API_KEY=sk-... \
  AGENTBOX_SECRETS='{"api.openai.com":"OPENAI_API_KEY","api.anthropic.com":{"env":"ANTHROPIC_API_KEY","header":"x-api-key"}}' npm start
curl -s -X POST localhost:7788/sandboxes -d '{"secrets":["api.openai.com"]}'
```

`AGENTBOX_SECRETS` is a JSON object of host to secret. A secret is a bare environment variable name, sent as `Authorization: Bearer <value>`, or `{"env":"VAR","header":"x-api-key","prefix":"","keys":["alice"]}` to name another header, an optional `prefix` for the value (none by default, which is what Anthropic's `x-api-key` needs), and the API keys allowed to use it. When the server has API keys, a create request gets a secret only if its key's name is in that secret's `keys` list; a secret with no `keys` list is usable by no key, and the server logs a startup warning naming it. When the server has no API keys, every secret is available. The value is read from the named variable at start and given only to the proxy; the host is allowlisted automatically. For that host the proxy terminates TLS with a certificate from its own CA, sets the header in place of whatever the sandbox sent, and opens its own TLS connection upstream. A request that names a host with no binding in `AGENTBOX_SECRETS` is refused, so a caller cannot point a secret at a host that would reflect it back. The CA is written into the sandbox at `/tmp/agentbox` and named by `SSL_CERT_FILE`, `REQUESTS_CA_BUNDLE`, `CURL_CA_BUNDLE`, `GIT_SSL_CAINFO`, `PIP_CERT` and `NODE_EXTRA_CA_CERTS`, alongside the image's normal bundle. Hosts without a secret are plain tunnels the proxy cannot read. A plain-HTTP request to a host with a secret is refused with 403 `host has a secret; use https`, so the value is only ever sent inside TLS. The integration test for this fetches `https://httpbin.org/headers` from inside a sandbox, sees the secret in the echoed headers, and greps the sandbox's environment and filesystem to confirm the value is not there.
