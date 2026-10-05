# Contributing to Hooka

Hooka is a Bun-first monorepo. Prefer Bun tooling and keep runtime behavior aligned with the project's single-node SQLite operating model.

## Local workflow

```bash
bun install
bun run check
bun run lint
bun run format:check
bun test --timeout 30000
bun run build
bun run test:dev-ui:smoke
bun run test:e2e:docker
```

Useful regeneration commands:

```bash
bun run bake:generate
bun run dockerfile:generate
```

Generated Docker files must stay committed. CI will fail if `docker/docker-bake.hcl`, the Dockerfile manifest-copy block, or the Dockerfile Bun base image drifts.

The Bun version is pinned once through `packageManager` in the root `package.json`. CI reads it with `setup-bun`, and `bun run dockerfile:generate` copies it into the `oven/bun` base image. Shared dependency ranges such as `zod` live in the root `workspaces.catalog` and are referenced with `catalog:`.

## Repo conventions

- Use Bun instead of Node, npm, pnpm, or Vite.
- Keep shared contracts in `packages/contracts`.
- Add new capabilities in `packages/cap-*`.
- Add new task packs in `packages/pack-*`.
- Add or promote worker presets in `packages/preset-catalog`.
- Use Zod for runtime validation and keep schemas strict.
- Prefer structured logs over ad-hoc `console.*` in long-running services.

## Tests and changes

- Add unit tests alongside the code you change.
- Prefer in-process tests before Docker-only coverage when a workflow can be exercised locally.
- For server changes, cover auth, rate limiting, and response shape regressions.
- For worker/store changes, cover retry, retention, and queue-state transitions.

## Changesets and releases

- Add a Sampo changeset under `.sampo/changesets/` for user-facing runtime, CLI, image, operator workflow, release workflow, or API changes.
- Use `npm/hooka` as the package id and choose `patch`, `minor`, or `major`.
- Use `patch` for backward-compatible preset additions and improvements, including their task packs, capabilities, preset-specific CLI operations and deployment templates. Hooka's root version also identifies preset images, so a new preset alone does not require a minor release.
- Use `minor` for backward-compatible additions to the shared Hooka runtime, queue, server API or general CLI. Use `major` for breaking changes to existing public behavior or contracts, including preset contracts.
- Optional changelog sections are `Added`, `Changed`, `Deprecated`, `Removed`, `Fixed`, and `Security`.
- Docs-only PRs do not need a changeset.
- Label rare release-neutral PRs with `no-release` or `skip-changeset`.
- CI also requires a changeset for `.sampo/config.toml` and `.github/workflows/sampo-release.yml` changes.
- After changesets merge to `main`, the Sampo workflow opens or updates the `Release Hooka` PR.
- Merge the release PR to publish the GitHub release, `vX.Y.Z` tag, and immutable GHCR image aliases.
- The release workflow publishes the images and immutable aliases first and only then creates the `vX.Y.Z` tag and GitHub release, so a failed image build leaves no tag behind and can be retried by re-running the workflow.

## Pull requests

- Keep unrelated operational automation changes in separate commits when possible.
- Mention any new env vars, CLI commands, or API endpoints in `README.md`.
- If you change Docker or image taxonomy, update release/deploy docs in the same branch.
