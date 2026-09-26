import { expect, test } from "bun:test";
import {
  evaluateChangesetCheck,
  parseNameStatus,
} from "./verify-sampo-changeset";

const repository = "imjlk/hooka";

test("release-relevant changes need an added or edited changeset", () => {
  expect(
    evaluateChangesetCheck({
      headRef: "feature",
      repository,
      headRepository: repository,
      labels: [],
      changedFiles: [{ status: "M", path: "apps/server/src/app.ts" }],
    }),
  ).toEqual({
    ok: false,
    releaseRelevantFiles: ["apps/server/src/app.ts"],
  });

  expect(
    evaluateChangesetCheck({
      headRef: "feature",
      labels: [],
      changedFiles: [
        { status: "M", path: "apps/server/src/app.ts" },
        { status: "A", path: ".sampo/changesets/fix.md" },
      ],
    }),
  ).toMatchObject({ ok: true });
});

test("a deleted changeset does not count as this PR's changeset", () => {
  expect(
    evaluateChangesetCheck({
      headRef: "feature",
      labels: [],
      changedFiles: [
        { status: "M", path: "packages/run-store/src/store.ts" },
        { status: "D", path: ".sampo/changesets/someone-elses.md" },
      ],
    }),
  ).toMatchObject({ ok: false });
});

test("only this repository's release branch skips the check", () => {
  const changedFiles = [{ status: "M", path: "package.json" }];

  expect(
    evaluateChangesetCheck({
      headRef: "codex/release",
      repository,
      headRepository: repository,
      labels: [],
      changedFiles,
    }),
  ).toMatchObject({ ok: true });
  expect(
    evaluateChangesetCheck({
      headRef: "codex/release",
      repository,
      headRepository: "someone/fork",
      labels: [],
      changedFiles,
    }),
  ).toMatchObject({ ok: false });
});

test("skip labels and docs-only changes pass, image inputs do not", () => {
  expect(
    evaluateChangesetCheck({
      headRef: "feature",
      labels: ["no-release"],
      changedFiles: [{ status: "M", path: "apps/cli/src/index.ts" }],
    }),
  ).toMatchObject({ ok: true });
  expect(
    evaluateChangesetCheck({
      headRef: "feature",
      labels: [],
      changedFiles: [{ status: "M", path: "docs/deploy/coolify.md" }],
    }),
  ).toMatchObject({ ok: true });
  expect(
    evaluateChangesetCheck({
      headRef: "feature",
      labels: [],
      changedFiles: [{ status: "M", path: ".dockerignore" }],
    }),
  ).toMatchObject({ ok: false });
});

test("parseNameStatus keeps the new path of renames", () => {
  expect(
    parseNameStatus(
      "M\tpackage.json\nR100\t.sampo/changesets/old.md\t.sampo/changesets/new.md\nD\tdocs/old.md\n",
    ),
  ).toEqual([
    { status: "M", path: "package.json" },
    { status: "R100", path: ".sampo/changesets/new.md" },
    { status: "D", path: "docs/old.md" },
  ]);
});
