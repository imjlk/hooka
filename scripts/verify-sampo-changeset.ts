const skipLabels = new Set(["no-release", "skip-changeset"]);
const releaseBranches = new Set([
  "codex/release",
  "release/main",
  "release-main",
]);

const relevantPrefixes = ["apps/", "packages/", "docker/", "scripts/"];
const relevantFiles = new Set([
  ".sampo/config.toml",
  ".env.example",
  ".github/workflows/publish-images.yml",
  ".github/workflows/sampo-release.yml",
  "bun.lock",
  "docker-compose.yml",
  "package.json",
]);

function normalizeLabelList(labels: string | undefined): string[] {
  return (labels ?? "")
    .split(",")
    .map((label) => label.trim())
    .filter(Boolean);
}

function isChangesetPath(filePath: string): boolean {
  return /^\.sampo\/changesets\/[^/]+\.md$/.test(filePath);
}

function requiresChangeset(filePath: string): boolean {
  return (
    relevantFiles.has(filePath) ||
    relevantPrefixes.some((prefix) => filePath.startsWith(prefix))
  );
}

async function listChangedFiles(): Promise<string[]> {
  const baseRef = Bun.env["GITHUB_BASE_REF"] ?? "main";

  await Bun.$`git fetch --no-tags --quiet origin ${baseRef}`.nothrow().quiet();

  const diff =
    await Bun.$`git diff --name-only ${`origin/${baseRef}`}...HEAD`.text();
  return diff
    .split("\n")
    .map((filePath) => filePath.trim())
    .filter(Boolean);
}

async function main(): Promise<void> {
  const headRef = Bun.env["GITHUB_HEAD_REF"] ?? "";
  if (releaseBranches.has(headRef)) {
    console.log(`Skipping changeset check for release branch ${headRef}.`);
    return;
  }

  const labels = normalizeLabelList(Bun.env["HOOKA_PR_LABELS"]);
  const skipLabel = labels.find((label) => skipLabels.has(label));
  if (skipLabel) {
    console.log(`Skipping changeset check because PR has ${skipLabel}.`);
    return;
  }

  const changedFiles = await listChangedFiles();
  const hasChangeset = changedFiles.some(isChangesetPath);
  const releaseRelevantFiles = changedFiles.filter(requiresChangeset);

  if (releaseRelevantFiles.length === 0) {
    console.log("No release-relevant files changed.");
    return;
  }

  if (hasChangeset) {
    console.log("Sampo changeset found.");
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
  for (const filePath of releaseRelevantFiles) {
    console.error(`- ${filePath}`);
  }
  process.exit(1);
}

await main();
