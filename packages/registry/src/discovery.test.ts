import { expect, test } from "bun:test";
import { createTempDir, ensureDir, removeDir } from "@hooka/bun-utils";
import { join } from "node:path";
import { discoverRegistryArtifacts } from "./discovery";

test("discoverRegistryArtifacts loads repo-local capability and task-pack manifests", async () => {
  const result = await discoverRegistryArtifacts(process.cwd());

  expect(result.errors).toEqual([]);
  expect(result.capabilities.map((capability) => capability.id)).toContain(
    "wrangler",
  );
  expect(result.webhookAdapters.map((adapter) => adapter.id)).toContain(
    "wordpress.simply-static",
  );
  expect(result.taskPacks.map((pack) => pack.id)).toContain(
    "@hooka/pack-wordpress-cloudflare",
  );
});

test("discoverRegistryArtifacts reports invalid manifests and exports", async () => {
  const tempDir = await createTempDir("hooka-registry-discovery");

  try {
    const packagesDir = join(tempDir, "packages");
    await ensureDir(packagesDir);

    await writeTempPackage(tempDir, "valid-cap", {
      packageJson: {
        name: "@temp/valid-cap",
        type: "module",
        hooka: {
          registry: {
            kind: "capability",
            export: "validCapability",
          },
        },
      },
      source: `
        export const validCapability = {
          id: "valid-capability",
          title: "Valid",
          description: "ok",
          binaries: ["bun"],
          healthcheck: { command: "bun" },
        };
      `,
    });

    await writeTempPackage(tempDir, "missing-export", {
      packageJson: {
        name: "@temp/missing-export",
        type: "module",
        hooka: {
          registry: {
            kind: "capability",
            export: "missingCapability",
          },
        },
      },
      source: `export const somethingElse = {};`,
    });

    await writeTempPackage(tempDir, "invalid-kind", {
      packageJson: {
        name: "@temp/invalid-kind",
        type: "module",
        hooka: {
          registry: {
            kind: "weird",
            export: "whatever",
          },
        },
      },
      source: `export const whatever = {};`,
    });

    await writeTempPackage(tempDir, "invalid-pack", {
      packageJson: {
        name: "@temp/invalid-pack",
        type: "module",
        hooka: {
          registry: {
            kind: "task-pack",
            export: "badPack",
          },
        },
      },
      source: `export const badPack = { title: "broken" };`,
    });

    await writeTempPackage(tempDir, "invalid-adapter", {
      packageJson: {
        name: "@temp/invalid-adapter",
        type: "module",
        hooka: {
          registry: {
            kind: "task-pack",
            export: "validPack",
            webhookAdapters: ["badAdapter", "missingAdapter"],
          },
        },
      },
      source: `
        export const validPack = {
          id: "@temp/valid-pack",
          title: "Valid Pack",
          description: "ok",
          tasks: [],
        };
        export const badAdapter = { routePath: "/broken" };
      `,
    });

    const result = await discoverRegistryArtifacts(tempDir);

    expect(result.capabilities.map((capability) => capability.id)).toEqual([
      "valid-capability",
    ]);
    expect(result.errors).toEqual(
      expect.arrayContaining([
        expect.stringContaining(
          "@temp/invalid-kind has an invalid hooka.registry.kind value.",
        ),
        expect.stringContaining(
          '@temp/missing-export points to missing export "missingCapability".',
        ),
        expect.stringContaining(
          '@temp/invalid-pack export "badPack" is not a valid task-pack definition.',
        ),
        expect.stringContaining(
          '@temp/invalid-adapter export "badAdapter" is not a valid webhook adapter.',
        ),
        expect.stringContaining(
          '@temp/invalid-adapter points to missing webhook adapter export "missingAdapter".',
        ),
      ]),
    );
  } finally {
    await removeDir(tempDir);
  }
});

async function writeTempPackage(
  rootDir: string,
  name: string,
  input: {
    packageJson: Record<string, unknown>;
    source: string;
  },
): Promise<void> {
  const packageDir = join(rootDir, "packages", name);
  const srcDir = join(packageDir, "src");
  await ensureDir(srcDir);
  await Bun.write(
    join(packageDir, "package.json"),
    `${JSON.stringify(input.packageJson, null, 2)}\n`,
  );
  await Bun.write(join(srcDir, "index.ts"), `${input.source.trim()}\n`);
}
