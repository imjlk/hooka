# Hooka Changelog

This changelog is managed by Sampo from `.sampo/changesets`.

Historical release notes before Sampo adoption live in:

- [`1.1.0`](./docs/releases/1.1.0.md)
- [`1.0.0`](./docs/releases/1.0.0.md)
- [`1.0.0-rc.1`](./docs/releases/1.0.0-rc.1.md)

## 1.2.0 — 2026-10-03

### Minor changes

- [6f73c0c](https://github.com/imjlk/hooka/commit/6f73c0c6c9af61fcf88d1edf1c859adfc9315b1d) Inspect, watch, and retry runs on a remote Hooka server with `run list/show/watch/retry --url`, admin token authentication, and bounded request timeouts. Authenticated remote connections require HTTPS unless `--allow-insecure-http` is explicitly set; local loopback HTTP remains supported. Filter run lists by status, task id, and source in both local SQLite and remote API modes. — Thanks @imjlk!

### Changed

- [1c88681](https://github.com/imjlk/hooka/commit/1c886810045ad48e6c2e3830e6bf5386b151d5ac) Run releases with the Sampo GitHub Action 0.19.0. Release PRs now keep the lockfile they were cut from, instead of the dependency re-resolution Sampo performs while bumping versions, so release images never ship dependency versions that CI has not tested. Also fix a flaky process executor test. — Thanks @imjlk!

## 1.1.2 — 2026-09-27

### Fixed

- [81be109](https://github.com/imjlk/hooka/commit/81be10976339ca898e6757a98d1988fc4af56333) The release workflow now creates the `vX.Y.Z` tag and GitHub release only after the release images and immutable aliases are published, so a failed image build can be retried instead of leaving a tagged release without images. — Thanks @imjlk!
- [9f7db4a](https://github.com/imjlk/hooka/commit/9f7db4a517046905a1766b542cc7f08576b7e1ad) CLI boolean flags now honor explicit values: `hooka target delete <id> --yes=false` no longer deletes the target and `hooka init --force=false` no longer overwrites `.env`; bare boolean task inputs such as `--no-bundle` are forwarded when another flag follows. `hooka status` reports an unauthorized summary instead of crashing, invalid server-only env no longer breaks every command, `hooka cleanup` takes kebab-case options (`--run-days`, `--audit-days`, `--worker-heartbeat-hours`), and `hooka --version` prints the release version. — Thanks @imjlk!
- [152776d](https://github.com/imjlk/hooka/commit/152776d40cb4ec1abd4c6d26166214b4bc03da95) Target policies now match destination prefixes on a path boundary and reject `..`, accept source roots with a trailing slash, reject source paths that escape an allowed root through a symlink, and read the source path from the field each task declares, so the built-in `export-verify` scaffold no longer fails every run. Readiness checks report unreadable or changing artifacts as preflight issues instead of leaving the run stuck until its lease expires. — Thanks @imjlk!
- [7c110c0](https://github.com/imjlk/hooka/commit/7c110c0551741a2acfc851737887b5c6e463e3f3) Stop multiple workers from running the same job after a lease expires, renew run leases and worker heartbeats while tasks execute, ignore results from workers that lost their lease, settle runs whose post-claim bookkeeping throws, and serialize schema migrations when the server and worker start together. — Thanks @imjlk!
- [123e7b1](https://github.com/imjlk/hooka/commit/123e7b120ffaba610f5cdd823e0770120d18bed1) Avoid duplicate release tags by skipping Sampo publish automation when a release PR merge has no pending changesets. — Thanks @imjlk!
- [ac55fd2](https://github.com/imjlk/hooka/commit/ac55fd29d8753fe2d9997ee5fcad424a8eea9100) Unknown `/api/*` routes now return JSON `404`/`405` instead of the admin UI shell (a mistyped webhook URL used to look like a successful delivery), `HEAD` works for every `GET` route, server-side faults such as a corrupt `targets.json` return a logged `500` instead of a `400` that stopped producers from retrying, URL target ids are percent-decoded, idle SSE streams send keepalives instead of disconnecting every 30 seconds, and the OpenAPI document lists every compatibility webhook route. — Thanks @imjlk!
- [7cbaea9](https://github.com/imjlk/hooka/commit/7cbaea956b741d7db3db12dd1a7b2aa2fed4e87b) Process task timeouts now stop the whole process group and escalate to SIGKILL, the default timeout is 10 minutes instead of 60 seconds so larger Pages deploys and rclone copies are not cut off, captured output is bounded, spawned tools no longer inherit `HOOKA_ADMIN_TOKEN` or `HOOKA_WEBHOOK_SECRET`, and HTTP tasks stop retrying deterministic `4xx` failures. — Thanks @imjlk!
- [e5cd358](https://github.com/imjlk/hooka/commit/e5cd358a9c7070d396294c1ff2c52683776b5f94) The admin UI no longer overwrites the target editor on every live update, so unsaved edits survive and a new scaffold can no longer be saved over an existing target with the same id. Live updates are coalesced to at most one refresh per second, and ids rendered into HTML attributes are escaped. — Thanks @imjlk!
- [061ba1c](https://github.com/imjlk/hooka/commit/061ba1c55018241ebbee1a281e5a779c4b2f21b5) Fix `wordpress.wpcli.eval`, which always failed because WP-CLI rejects `--path <value>`; keep wrangler option values attached so commit messages that start with `-` no longer break or rewrite deploys; reject dash-prefixed task paths and malformed Cloudflare zone ids; accept webhook `triggeredAt` timestamps with UTC offsets; and let target webhooks fall back to the target's `source`. — Thanks @imjlk!
- [19d8168](https://github.com/imjlk/hooka/commit/19d8168fb86421254366138f6b74bcbc1f001e1f) Retrying a run from the admin UI, API, or `hooka run retry` now keeps the original target's policy snapshot, concurrency limit, and attempt budget, so a retried deploy can no longer skip target preflight checks or run alongside another deploy of the same target. — Thanks @imjlk!

### Changed

- [47aa655](https://github.com/imjlk/hooka/commit/47aa655b968140667d5fb8b8fda479dc07ef9771) Typecheck `scripts/` and `examples/` in CI, make the changeset check ignore deleted changesets and forked `codex/release` branches (and treat `.dockerignore` as image input), print container logs when the Docker E2E fails, and make the WordPress signing example print the exact signed body and a working `curl` command. — Thanks @imjlk!
- [282b4b5](https://github.com/imjlk/hooka/commit/282b4b57e9e6f35aa631dfbabb37741e7c8872a2) Run Hooka images and CI on Bun 1.4.2, pinned once through `packageManager`, and refresh zod, Bunli, TypeScript 7, Biome, and the Bun/Node type definitions. — Thanks @imjlk!

### Security

- [88af933](https://github.com/imjlk/hooka/commit/88af9333e81fd2cf06be9c4c23a0f05efc6fd468) Rate limits and audit rows now use the connecting socket address, or the proxy-written end of `X-Forwarded-For` when `HOOKA_TRUST_PROXY` is set, instead of the forgeable left-most entry. `HOOKA_TRUST_PROXY` also accepts the number of trusted proxies (for example `2` behind Cloudflare and Coolify). Per-client limits no longer include the caller-chosen User-Agent, a client over its own limit no longer spends the shared global budget, and repeated security rejections from one client are audited once per window, so an unauthenticated flood cannot lock out legitimate callers or fill the database. — Thanks @imjlk!
- [768477d](https://github.com/imjlk/hooka/commit/768477ddf30f601746e8a973112aab75bc8d046d) Locally built images no longer bake in `.env` files (Bun auto-loaded them at runtime). The `wp-ops` and `wp-wrangler` images now ship a working WP-CLI: it is pinned to 2.12.0, checked against its published SHA-512, and installed with the Phar, mysqli, mbstring, and OpenSSL extensions it needs (the `wp` binary previously failed with `Class "Phar" not found`). Wrangler is pinned to 4.141.0, and the local compose worker no longer receives the webhook secret and gets a stop grace period. — Thanks @imjlk!
- [2d7a752](https://github.com/imjlk/hooka/commit/2d7a7527b6d3d3d85a95be31252a31d60a7f6eee) Pin every GitHub Actions dependency to a full commit SHA, update checkout, setup-bun, and the Docker actions to their latest releases, and stop persisting the job token in checkouts that never push. — Thanks @imjlk!

## 1.1.1 — 2026-06-15

### Fixed

- [e22e279](https://github.com/imjlk/hooka/commit/e22e279848763853ee10e05f2f10b65919f42ad1) Harden TrailBase Pages deploy runs by retrying SQLite store startup locks and rejecting Wrangler runs without a verifiable Pages deployment signal. — Thanks @imjlk!
- [12f5943](https://github.com/imjlk/hooka/commit/12f59433563869181d0d39e9e4b576dce4651442) Fix Sampo release PR branch pushes when checkout credentials are not persisted. — Thanks @imjlk!

### Changed

- [35f5c62](https://github.com/imjlk/hooka/commit/35f5c62999b2f34e4df209601a81ae5e42c227ad) Add Sampo changesets and release PR automation for Hooka releases. — Thanks @imjlk!

