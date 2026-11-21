# Changelog

## 0.3.0 (unreleased)

- The npm package ships only the listed documentation files.
- Two servers can share a Docker host: each labels its containers, networks and proxy with its own id and only reaps its own.
- The default database path moved to `~/.local/share/agentbox/agentbox.db` (under `XDG_DATA_HOME` when set). A server that already has `./data/agentbox.db` keeps using it and logs a notice, so upgrades do not lose data. Set `AGENTBOX_DB` to choose the path.
