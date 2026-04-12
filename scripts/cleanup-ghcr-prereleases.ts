import {
  listActiveWorkerPresets,
  serverImageTag,
} from "../packages/preset-catalog/src/index.ts";

const stableVersionPattern = /^\d+\.\d+\.\d+$/;
const prereleaseVersionPattern = /^(\d+\.\d+\.\d+)-[0-9A-Za-z][0-9A-Za-z.-]*$/;

export type KnownTagClassification =
  | {
      kind: "mutable";
      artifactTag: string;
      tag: string;
    }
  | {
      kind: "immutable-stable";
      artifactTag: string;
      tag: string;
      version: string;
    }
  | {
      kind: "immutable-prerelease";
      artifactTag: string;
      tag: string;
      version: string;
      baseVersion: string;
    }
  | {
      kind: "unknown";
      tag: string;
    };

export interface GhcrPackageVersion {
  id: number;
  metadata?: {
    container?: {
      tags?: string[];
    };
  };
}

interface CleanupCandidate {
  id: number;
  tags: string[];
}

function getRepositoryRef(): string {
  const repository = Bun.env["GITHUB_REPOSITORY"];
  if (!repository) {
    throw new Error("GITHUB_REPOSITORY is required.");
  }
  return repository;
}

function getGithubToken(): string {
  const token = Bun.env["GITHUB_TOKEN"];
  if (!token) {
    throw new Error("GITHUB_TOKEN is required.");
  }
  return token;
}

export function normalizeReleaseVersion(version: string): string {
  return version.startsWith("v") ? version.slice(1) : version;
}

export function listArtifactTags(): string[] {
  return [
    serverImageTag,
    ...listActiveWorkerPresets().map(
      (preset) => preset.publicWorkerTag ?? preset.imageTag,
    ),
  ];
}

export function classifyContainerTag(
  tag: string,
  artifactTags: string[],
): KnownTagClassification {
  if (artifactTags.includes(tag)) {
    return {
      kind: "mutable",
      artifactTag: tag,
      tag,
    };
  }

  const sortedArtifactTags = [...artifactTags].sort((left, right) => {
    return right.length - left.length;
  });

  for (const artifactTag of sortedArtifactTags) {
    const suffix = `-${artifactTag}`;
    if (!tag.endsWith(suffix)) {
      continue;
    }

    const version = tag.slice(0, -suffix.length);

    if (stableVersionPattern.test(version)) {
      return {
        kind: "immutable-stable",
        artifactTag,
        tag,
        version,
      };
    }

    const prereleaseMatch = prereleaseVersionPattern.exec(version);
    if (prereleaseMatch) {
      return {
        kind: "immutable-prerelease",
        artifactTag,
        tag,
        version,
        baseVersion: prereleaseMatch[1],
      };
    }

    return {
      kind: "unknown",
      tag,
    };
  }

  return {
    kind: "unknown",
    tag,
  };
}

export function selectPrunablePackageVersions(
  versions: GhcrPackageVersion[],
  releaseVersion: string,
  artifactTags: string[],
): CleanupCandidate[] {
  return versions.flatMap((version) => {
    const tags = version.metadata?.container?.tags ?? [];
    if (tags.length === 0) {
      return [];
    }

    const classifications = tags.map((tag) => {
      return classifyContainerTag(tag, artifactTags);
    });

    const allPrereleaseForLine = classifications.every((classification) => {
      return (
        classification.kind === "immutable-prerelease" &&
        classification.baseVersion === releaseVersion
      );
    });

    if (!allPrereleaseForLine) {
      return [];
    }

    return [
      {
        id: version.id,
        tags,
      },
    ];
  });
}

async function githubApiRequest(
  path: string,
  init: RequestInit = {},
): Promise<Response> {
  const token = getGithubToken();
  const response = await fetch(`https://api.github.com${path}`, {
    ...init,
    headers: {
      Accept: "application/vnd.github+json",
      Authorization: `Bearer ${token}`,
      "X-GitHub-Api-Version": "2022-11-28",
      ...init.headers,
    },
  });

  if (!response.ok) {
    const body = await response.text();
    throw new Error(
      `GitHub API request failed (${response.status} ${response.statusText}) for ${path}: ${body}`,
    );
  }

  return response;
}

async function resolvePackageOwnerKind(
  repository: string,
): Promise<"users" | "orgs"> {
  const response = await githubApiRequest(`/repos/${repository}`);
  const data = (await response.json()) as {
    owner?: {
      type?: string;
    };
  };

  return data.owner?.type === "Organization" ? "orgs" : "users";
}

async function listPackageVersions(
  owner: string,
  ownerKind: "users" | "orgs",
  packageName: string,
): Promise<GhcrPackageVersion[]> {
  const versions: GhcrPackageVersion[] = [];

  for (let page = 1; ; page += 1) {
    const response = await githubApiRequest(
      `/${ownerKind}/${owner}/packages/container/${packageName}/versions?page=${page}&per_page=100`,
    );
    const data = (await response.json()) as GhcrPackageVersion[];
    versions.push(...data);

    if (data.length < 100) {
      return versions;
    }
  }
}

async function deletePackageVersion(
  owner: string,
  ownerKind: "users" | "orgs",
  packageName: string,
  versionId: number,
): Promise<void> {
  await githubApiRequest(
    `/${ownerKind}/${owner}/packages/container/${packageName}/versions/${versionId}`,
    {
      method: "DELETE",
    },
  );
}

async function main(): Promise<void> {
  const requestedVersion = Bun.env["HOOKA_RELEASE_VERSION"];
  if (!requestedVersion) {
    throw new Error("HOOKA_RELEASE_VERSION is required.");
  }

  const releaseVersion = normalizeReleaseVersion(requestedVersion);
  if (!stableVersionPattern.test(releaseVersion)) {
    throw new Error(
      `HOOKA_RELEASE_VERSION must be a stable version like 1.0.0 or v1.0.0. Received: ${requestedVersion}`,
    );
  }

  const repository = getRepositoryRef();
  const owner = repository.split("/")[0];
  if (!owner) {
    throw new Error(`Invalid GITHUB_REPOSITORY: ${repository}`);
  }

  const ownerKind = await resolvePackageOwnerKind(repository);
  const packageName =
    Bun.env["HOOKA_GHCR_PACKAGE_NAME"] ??
    repository.split("/")[1]?.toLowerCase();
  if (!packageName) {
    throw new Error(`Unable to derive package name from ${repository}.`);
  }

  const artifactTags = listArtifactTags();
  const apply = Bun.env["HOOKA_CLEANUP_APPLY"] === "true";
  const versions = await listPackageVersions(owner, ownerKind, packageName);
  const candidates = selectPrunablePackageVersions(
    versions,
    releaseVersion,
    artifactTags,
  );

  console.log(
    JSON.stringify(
      {
        repository,
        packageName,
        releaseVersion,
        apply,
        inspectedVersionCount: versions.length,
        candidateCount: candidates.length,
        candidates,
      },
      null,
      2,
    ),
  );

  if (!apply) {
    console.log("Dry run only. No GHCR package versions were deleted.");
    return;
  }

  for (const candidate of candidates) {
    await deletePackageVersion(owner, ownerKind, packageName, candidate.id);
    console.log(
      `Deleted GHCR package version ${candidate.id} (${candidate.tags.join(", ")})`,
    );
  }
}

if (import.meta.main) {
  await main();
}
