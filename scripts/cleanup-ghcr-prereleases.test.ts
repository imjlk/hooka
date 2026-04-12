import { describe, expect, test } from "bun:test";
import {
  classifyContainerTag,
  normalizeReleaseVersion,
  selectPrunablePackageVersions,
  type GhcrPackageVersion,
} from "./cleanup-ghcr-prereleases.ts";

const artifactTags = [
  "webhook-server",
  "core",
  "cf-pages",
  "cf-cache",
  "rclone-sync",
  "wp-ops",
  "wp-wrangler",
];

describe("normalizeReleaseVersion", () => {
  test("strips a leading v", () => {
    expect(normalizeReleaseVersion("v1.0.0")).toBe("1.0.0");
    expect(normalizeReleaseVersion("1.0.0")).toBe("1.0.0");
  });
});

describe("classifyContainerTag", () => {
  test("classifies mutable tags", () => {
    expect(classifyContainerTag("webhook-server", artifactTags)).toEqual({
      kind: "mutable",
      artifactTag: "webhook-server",
      tag: "webhook-server",
    });
  });

  test("classifies stable immutable tags", () => {
    expect(classifyContainerTag("1.0.0-rclone-sync", artifactTags)).toEqual({
      kind: "immutable-stable",
      artifactTag: "rclone-sync",
      tag: "1.0.0-rclone-sync",
      version: "1.0.0",
    });
  });

  test("classifies prerelease immutable tags", () => {
    expect(
      classifyContainerTag("1.0.0-rc.1-webhook-server", artifactTags),
    ).toEqual({
      kind: "immutable-prerelease",
      artifactTag: "webhook-server",
      tag: "1.0.0-rc.1-webhook-server",
      version: "1.0.0-rc.1",
      baseVersion: "1.0.0",
    });
  });

  test("leaves unknown tags untouched", () => {
    expect(classifyContainerTag("latest", artifactTags)).toEqual({
      kind: "unknown",
      tag: "latest",
    });
  });
});

describe("selectPrunablePackageVersions", () => {
  test("selects only prerelease versions for the matching release line", () => {
    const versions: GhcrPackageVersion[] = [
      {
        id: 101,
        metadata: {
          container: {
            tags: ["1.0.0-rc.1-webhook-server"],
          },
        },
      },
      {
        id: 102,
        metadata: {
          container: {
            tags: ["1.0.0-webhook-server"],
          },
        },
      },
      {
        id: 103,
        metadata: {
          container: {
            tags: ["webhook-server"],
          },
        },
      },
      {
        id: 104,
        metadata: {
          container: {
            tags: ["1.1.0-rc.1-webhook-server"],
          },
        },
      },
      {
        id: 105,
        metadata: {
          container: {
            tags: ["1.0.0-rc.1-webhook-server", "1.0.0-rc.1-cf-pages"],
          },
        },
      },
      {
        id: 106,
        metadata: {
          container: {
            tags: ["1.0.0-rc.1-webhook-server", "webhook-server"],
          },
        },
      },
      {
        id: 107,
        metadata: {
          container: {
            tags: ["1.0.0-rc.1-rclone-sync", "latest"],
          },
        },
      },
      {
        id: 108,
        metadata: {
          container: {
            tags: [],
          },
        },
      },
    ];

    expect(
      selectPrunablePackageVersions(versions, "1.0.0", artifactTags),
    ).toEqual([
      {
        id: 101,
        tags: ["1.0.0-rc.1-webhook-server"],
      },
      {
        id: 105,
        tags: ["1.0.0-rc.1-webhook-server", "1.0.0-rc.1-cf-pages"],
      },
    ]);
  });
});
