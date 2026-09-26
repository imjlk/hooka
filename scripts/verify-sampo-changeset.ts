const skipLabels = new Set(["no-release", "skip-changeset"]);
const releaseBranches = new Set([
  "codex/release",
  "release/main",
  "release-main",
]);

const relevantPrefixes = ["apps/", "packages/", "docker/", "scripts/"];
const relevantFiles = new Set([
  ".dockerignore",
  ".sampo/config.toml",
  ".env.example",
  ".github/workflows/publish-images.yml",
  ".github/workflows/sampo-release.yml",
  "bun.lock",
  "docker-compose.yml",
  "package.json",
]);

export interface ChangedFile {
  path: string;
  /** Status letter from `git diff --name-status` (A, M, D, R, ...). */
  status: string;
}

export interface ChangesetCheckInput {
  headRef: string;
  /** `owner/name` of the PR head repository, when known. */
  headRepository?: string;
  /** `owner/name` of this repository, when known. */
  repository?: string;
  labels: string[];
  changedFiles: ChangedFile[];
}

export type ChangesetCheckResult =
  | { ok: true; message: string }
  | { ok: false; releaseRelevantFiles: string[] };

export function normalizeLabelList(labels: string | undefined): string[] {
  return (labels ?? "")
    .split(",")
    .map((label) => label.trim())
    .filter(Boolean);
}

export function isChangesetPath(filePath: string): boolean {
  return /^\.sampo\/changesets\/[^/]+\.md$/.test(filePath);
}

export function requiresChangeset(filePath: string): boolean {
  return (
    relevantFiles.has(filePath) ||
    relevantPrefixes.some((prefix) => filePath.startsWith(prefix))
  );
}

export function evaluateChangesetCheck(
  input: ChangesetCheckInput,
): ChangesetCheckResult {
  // Only this repository's release branch skips the check; a fork can name
  // its branch `codex/release` too.
  const fromThisRepository =
    !input.headRepository ||
    !input.repository ||
    input.headRepository === input.repository;
  if (releaseBranches.has(input.headRef) && fromThisRepository) {
    return {
      ok: true,
      message: `Skipping changeset check for release branch ${input.headRef}.`,
    };
  }

  const skipLabel = input.labels.find((label) => skipLabels.has(label));
  if (skipLabel) {
    return {
      ok: true,
      message: `Skipping changeset check because PR has ${skipLabel}.`,
    };
  }

  const releaseRelevantFiles = input.changedFiles
    .map((file) => file.path)
    .filter(requiresChangeset);
  if (releaseRelevantFiles.length === 0) {
    return { ok: true, message: "No release-relevant files changed." };
  }

  // Deleting or consuming an existing changeset does not describe this PR.
  const hasChangeset = input.changedFiles.some(
    (file) => !file.status.startsWith("D") && isChangesetPath(file.path),
  );
  if (hasChangeset) {
    return { ok: true, message: "Sampo changeset found." };
  }

  return { ok: false, releaseRelevantFiles };
}

export function parseNameStatus(output: string): ChangedFile[] {
  return output
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean)
    .flatMap((line) => {
      const [status, ...paths] = line.split("\t");
      // Renames and copies list the old path first; keep the new one.
      const path = paths.at(-1);
      return status && path ? [{ status, path }] : [];
    });
}

async function listChangedFiles(): Promise<ChangedFile[]> {
  const baseRef = Bun.env["GITHUB_BASE_REF"] ?? "main";

  await Bun.$`git fetch --no-tags --quiet origin ${baseRef}`.nothrow().quiet();

  return parseNameStatus(
    await Bun.$`git diff --name-status ${`origin/${baseRef}`}...HEAD`.text(),
  );
}

async function main(): Promise<void> {
  const result = evaluateChangesetCheck({
    headRef: Bun.env["GITHUB_HEAD_REF"] ?? "",
    headRepository: Bun.env["HOOKA_PR_HEAD_REPO"] || undefined,
    repository: Bun.env["GITHUB_REPOSITORY"] || undefined,
    labels: normalizeLabelList(Bun.env["HOOKA_PR_LABELS"]),
    changedFiles: await listChangedFiles(),
  });

  if (result.ok) {
    console.log(result.message);
    return;
  }

  console.error(
    "This PR changes release-relevant files but has no Sampo changeset.",
  );
  console.error("Add a file under .sampo/changesets/*.md, for example:");
  console.error("---");
  console.error("npm/hooka: patch (Changed)");
  console.error("---");
  console.error("");
  console.error("Release-relevant files:");
  for (const filePath of result.releaseRelevantFiles) {
    console.error(`- ${filePath}`);
  }
  process.exit(1);
}

if (import.meta.main) {
  await main();
}
