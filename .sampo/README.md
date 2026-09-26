# Sampo

Hooka uses Sampo to manage changesets, the root `hooka` version, changelog
updates, release PRs, GitHub releases, and `vX.Y.Z` release tags.

## Hooka Changesets

Add one Markdown file under `.sampo/changesets/` for user-facing runtime,
operator, CLI, image, or release workflow changes:

```md
---
npm/hooka: minor (Added)
---

Describe the user-facing change.
```

Use `patch`, `minor`, or `major`. Optional changelog sections are `Added`,
`Changed`, `Deprecated`, `Removed`, `Fixed`, and `Security`.

Docs-only PRs do not need a changeset. For rare release-neutral automation
changes, label the PR `no-release` or `skip-changeset`.

## Release Flow

When changesets land on `main`, `.github/workflows/sampo-release.yml` opens or
updates the `Release Hooka` PR from `codex/release`. The workflow only invokes
Sampo while pending changesets exist, so merging the release PR does not run
Sampo's publish/tag path for Hooka's private root package. Because that package
is only used as release metadata, the workflow creates the `vX.Y.Z` tag and
GitHub release itself when the version has no matching tag yet. It then
publishes current Hooka images and immutable GHCR aliases for the released
version.

## Quick Links

- Documentation: https://github.com/bruits/sampo/blob/main/crates/sampo/README.md
- GitHub Action: https://github.com/bruits/sampo/blob/main/crates/sampo-github-action/README.md
- GitHub Bot: https://github.com/bruits/sampo/blob/main/crates/sampo-github-bot/README.md

## Tooling Notes

The release workflow intentionally pins the Sampo GitHub Action to
`v0.16.0`. Sampo `0.19+` refreshes `bun.lock` with
`bun update --lockfile-only --no-save` while it prepares a release, which
re-resolves every dependency to the newest in-range version. Release PRs are
opened with `GITHUB_TOKEN`, so CI does not run on them, and those untested
lockfile upgrades would ship straight into the release images. Upgrade Sampo
only together with a guard for that behavior.
