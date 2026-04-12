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

Generated Docker files must stay committed. CI will fail if either `docker/docker-bake.hcl` or the Dockerfile manifest-copy block drifts.

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

## Pull requests

- Keep unrelated operational automation changes in separate commits when possible.
- Mention any new env vars, CLI commands, or API endpoints in `README.md`.
- If you change Docker or image taxonomy, update release/deploy docs in the same branch.
