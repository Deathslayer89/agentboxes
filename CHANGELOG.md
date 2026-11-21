# Changelog

## 0.3.0 (unreleased)

- BREAKING: a secret in `AGENTBOX_SECRETS` is now available to an API key only when that key's name is in the secret's `keys` list. When the server runs with API keys, a secret with no `keys` list is usable by no key (and the server logs a startup warning); a create request for a secret the key is not allowed returns 403. When the server runs with no API keys, every secret is available as before.

  Migration: add the allowed key names to each secret.

  ```
  # before
  AGENTBOX_SECRETS='{"api.openai.com":"OPENAI_API_KEY"}'
  # after
  AGENTBOX_SECRETS='{"api.openai.com":{"env":"OPENAI_API_KEY","keys":["alice"]}}'
  ```

- BREAKING: a sandbox now has a maximum lifetime from creation, `MAX_LIFETIME_SECONDS` (default 86400, one day; 0 disables), so a sandbox can no longer be kept alive indefinitely. `extend` cannot push a sandbox past it. The sandbox info includes `maxExpiresAt` (createdAt plus the cap), absent when the cap is 0.
- BREAKING: an exec whose `timeoutMs` is longer than the sandbox's remaining TTL is refused with 409 instead of being allowed to run; the default timeout is clamped to the remaining TTL, and a command stopped that way reports `timedOut` with `reason: "ttl"` so it is not mistaken for an ordinary timeout. The Python client's `ExecResult` gains an optional `reason` field carrying this.
- BREAKING: a file or archive upload larger than the limit now returns 413 (Payload Too Large) instead of 400.
- The egress proxy is more robust against bad requests and expired certificates: a malformed control-API body is answered with 400 instead of crashing the proxy (which would cut egress for every sandbox), an unexpected error makes the proxy process exit rather than run in an undefined state, a failed certificate issue is no longer cached, and leaf certificates are renewed before their 30-day expiry.
- The server now owns the egress proxy's certificate authority: generated once with openssl, stored with a private key readable only by the server (0600) under the data directory, and handed to the proxy over the control API instead of an environment variable, so the key never sits in the proxy's environment. The proxy refuses to intercept a secret host until it has been given a CA. The CA survives a restart. A plain server restart reuses the running proxy, so networked sandboxes keep egress without interruption. A networked create made while egress is unavailable (the proxy has not started, or it crashed) is now refused with 503, where egress-off-at-startup previously answered 400. If the proxy crashes while the server runs, egress is marked unavailable and existing networked sandboxes keep running without egress; restarting the server re-registers them, and their egress comes back within about 40 seconds, once each sandbox's network stack drops the replaced proxy's old MAC.
- BREAKING for source installs: running the server from a clone now needs openssl on the host (the Docker image already installs it).
- A sandbox killed by its memory limit is marked destroyed when the exec that killed it returns, rather than staying `ready` until a reaper pass; a healthy sandbox whose command merely exits 137 or 128 on its own is left running and no longer waits on a death check.
- The MCP server keeps one sandbox per session and shares a single create across parallel tool calls, so a burst of tools does not leave extra sandboxes running.
- The npm package ships only the listed documentation files.
- Two servers can share a Docker host: each labels its containers, networks and proxy with its own id and only reaps its own.
- The default database path moved to `~/.local/share/agentbox/agentbox.db` (under `XDG_DATA_HOME` when set). A server that already has `./data/agentbox.db` keeps using it and logs a notice, so upgrades do not lose data. Set `AGENTBOX_DB` to choose the path.
