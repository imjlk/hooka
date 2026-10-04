---
npm/hooka: patch
---

Replace Bunli with Gunshi for the operations CLI, removing the transitive OpenTUI native runtime from Hooka images. Preserve nested commands, Zod task validation, positional arguments, JSON output, and explicit boolean values such as `--yes=false` and `--no-bundle=false`.
