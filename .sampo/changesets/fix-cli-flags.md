---
npm/hooka: patch (Fixed)
---

CLI boolean flags now honor explicit values: `hooka target delete <id> --yes=false` no longer deletes the target and `hooka init --force=false` no longer overwrites `.env`; bare boolean task inputs such as `--no-bundle` are forwarded when another flag follows. `hooka status` reports an unauthorized summary instead of crashing, invalid server-only env no longer breaks every command, `hooka cleanup` takes kebab-case options (`--run-days`, `--audit-days`, `--worker-heartbeat-hours`), and `hooka --version` prints the release version.
