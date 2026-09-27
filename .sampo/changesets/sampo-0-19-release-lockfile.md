---
npm/hooka: patch (Changed)
---

Run releases with the Sampo GitHub Action 0.19.0. Release PRs now keep the lockfile they were cut from, instead of the dependency re-resolution Sampo performs while bumping versions, so release images never ship dependency versions that CI has not tested. Also fix a flaky process executor test.
