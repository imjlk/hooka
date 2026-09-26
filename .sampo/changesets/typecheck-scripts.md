---
npm/hooka: patch (Changed)
---

Typecheck `scripts/` and `examples/` in CI, make the changeset check ignore deleted changesets and forked `codex/release` branches (and treat `.dockerignore` as image input), print container logs when the Docker E2E fails, and make the WordPress signing example print the exact signed body and a working `curl` command.
