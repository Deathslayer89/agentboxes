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

- BREAKING: a file or archive upload larger than the limit now returns 413 (Payload Too Large) instead of 400.
- A sandbox killed by its memory limit is marked destroyed when the exec that killed it returns, rather than staying `ready` until a reaper pass; a healthy sandbox whose command merely exits 137 or 128 on its own is left running and no longer waits on a death check.
- The MCP server keeps one sandbox per session and shares a single create across parallel tool calls, so a burst of tools does not leave extra sandboxes running.
- The npm package ships only the listed documentation files.
- Two servers can share a Docker host: each labels its containers, networks and proxy with its own id and only reaps its own.
- The default database path moved to `~/.local/share/agentbox/agentbox.db` (under `XDG_DATA_HOME` when set). A server that already has `./data/agentbox.db` keeps using it and logs a notice, so upgrades do not lose data. Set `AGENTBOX_DB` to choose the path.
