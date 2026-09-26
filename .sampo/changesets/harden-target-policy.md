---
npm/hooka: patch (Fixed)
---

Target policies now match destination prefixes on a path boundary and reject `..`, accept source roots with a trailing slash, reject source paths that escape an allowed root through a symlink, and read the source path from the field each task declares, so the built-in `export-verify` scaffold no longer fails every run. Readiness checks report unreadable or changing artifacts as preflight issues instead of leaving the run stuck until its lease expires.
