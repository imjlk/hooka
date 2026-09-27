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

The release workflow runs the Sampo GitHub Action `v0.19.0` and sets up Bun
before it, because Sampo refuses to prepare a release without Bun on `PATH`.

While preparing the release PR, Sampo refreshes `bun.lock` with
`bun update --lockfile-only --no-save`, which re-resolves every dependency to
the newest in-range version. Release PRs are opened with `GITHUB_TOKEN`, so CI
never runs on them, and the release images would ship those untested
resolutions. The workflow therefore restores the lockfile the release branch
was cut from ("Keep the base lockfile on the release PR"). A release only
bumps Hooka's private root version, so that lockfile stays valid. Update
dependencies through regular PRs, where CI runs.
