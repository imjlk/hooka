import { defineCommand, option } from "@bunli/core";
import { ensureDir, ensureParentDir } from "@hooka/bun-utils";
import { getDefaultManifestPath, getDefaultTargetsPath } from "@hooka/config";
import { getPreset, getPresetPlan, listPresets } from "@hooka/registry";
import { join } from "node:path";
import { z } from "zod";
import {
  booleanFlagSchema,
  createInstalledCapabilitiesManifest,
  resolveBooleanFlag,
  resolveCliSourceRoot,
  writeInstalledCapabilitiesManifest,
} from "../lib/shared";

const defaultPresetId = "cf-pages";

export function createInitCommand() {
  return defineCommand({
    name: "init",
    description:
      "Create a local .env, manifest, and shared-source scaffold for Hooka.",
    options: {
      preset: option(z.string().optional(), {
        description: "Preset id to scaffold for. Defaults to cf-pages.",
      }),
      yes: option(booleanFlagSchema, {
        description: "Use recommended defaults without prompting.",
      }),
      force: option(booleanFlagSchema, {
        description: "Overwrite existing .env and manifest files.",
      }),
    },
    handler: async ({ flags }) => {
      const yes = resolveBooleanFlag(flags.yes, "--yes");
      const force = resolveBooleanFlag(flags.force, "--force");
      const presetId =
        flags.preset ??
        (yes ? defaultPresetId : await promptForPreset(defaultPresetId));
      const preset = getPreset(presetId);

      if (!preset) {
        throw new Error(`Unknown preset: ${presetId}`);
      }

      const plan = getPresetPlan(preset.id);

      if (!plan) {
        throw new Error(`Missing preset plan for ${preset.id}.`);
      }

      const projectDir = process.cwd();
      const repoRoot = resolveCliSourceRoot();
      const envExamplePath = join(repoRoot, ".env.example");
      const envPath = join(projectDir, ".env");
      const manifestPath = getDefaultManifestPath(projectDir, {});
      const targetsPath = getDefaultTargetsPath(projectDir, {});
      const sharedSourcePath = join(
        projectDir,
        ".hooka/shared-source/simply-static",
      );
      const envTemplate = await Bun.file(envExamplePath).text();

      if (envTemplate.length === 0) {
        throw new Error(`Missing .env example template at ${envExamplePath}.`);
      }

      if (!(await Bun.file(envPath).exists()) || force) {
        const envContents = applyPresetToEnvTemplate(
          envTemplate,
          plan.capabilities,
        );
        await ensureParentDir(envPath);
        await Bun.write(envPath, envContents);
      }

      if (!(await Bun.file(manifestPath).exists()) || force) {
        const manifest = createInstalledCapabilitiesManifest({
          image: `hooka:local-${plan.publicWorkerTag ?? preset.id}`,
          installed: plan.capabilities,
        });
        await writeInstalledCapabilitiesManifest(manifestPath, manifest);
      }

      if (!(await Bun.file(targetsPath).exists()) || force) {
        await ensureParentDir(targetsPath);
        await Bun.write(
          targetsPath,
          `${JSON.stringify(
            {
              targets: createDefaultTargetsForPreset(
                preset.id,
                sharedSourcePath,
              ),
            },
            null,
            2,
          )}\n`,
        );
      }

      await ensureDir(sharedSourcePath);

      console.log(`Initialized Hooka DX scaffold for preset "${preset.id}".`);
      console.log(`- .env: ${envPath}`);
      console.log(`- manifest: ${manifestPath}`);
      console.log(`- targets: ${targetsPath}`);
      console.log(`- shared source: ${sharedSourcePath}`);
      console.log("Next steps:");
      console.log("- hooka dev");
      console.log("- hooka status");
      console.log("- hooka target list");
      console.log(
        `- hooka webhook test --task-id deploy.shared-volume.wrangler --payload-json '{"kind":"pages-deploy","project":"staging-site","sourcePath":"${sharedSourcePath}"}'`,
      );
      console.log("- docker compose up --build");
    },
  });
}

async function promptForPreset(defaultValue: string): Promise<string> {
  const presets = listPresets();
  console.log("Select a preset:");

  for (const [index, preset] of presets.entries()) {
    const marker = preset.id === defaultValue ? " (default)" : "";
    console.log(`${index + 1}. ${preset.id} - ${preset.description}${marker}`);
  }

  const response = prompt(`Preset [${defaultValue}]:`)?.trim();

  if (!response) {
    return defaultValue;
  }

  const asNumber = Number(response);

  if (
    Number.isInteger(asNumber) &&
    asNumber > 0 &&
    asNumber <= presets.length
  ) {
    return presets[asNumber - 1]?.id ?? defaultValue;
  }

  return response;
}

function applyPresetToEnvTemplate(
  template: string,
  capabilities: string[],
): string {
  const installedCapabilities = capabilities.join(",");
  const next = template.replace(
    /^HOOKA_INSTALLED_CAPABILITIES=.*$/m,
    `HOOKA_INSTALLED_CAPABILITIES=${installedCapabilities}`,
  );

  return next.endsWith("\n") ? next : `${next}\n`;
}

function createDefaultTargetsForPreset(
  presetId: string,
  sharedSourcePath: string,
): Array<Record<string, unknown>> {
  if (presetId === "cf-pages" || presetId === "wp-wrangler") {
    return [
      {
        id: `${presetId}-default`,
        title: `${presetId} default deploy`,
        description: "Edit this target before using target-based webhooks.",
        taskId: "deploy.shared-volume.wrangler",
        source: "target.local",
        defaultInput: {
          kind: "pages-deploy",
          project: "change-me",
          sourcePath: sharedSourcePath,
          branch: "main",
        },
        maxAttempts: 3,
        policy: {
          allowedProjects: ["change-me"],
          allowedSourceRoots: [join(process.cwd(), ".hooka/shared-source")],
          allowedBranches: ["main"],
          allowedOverrideFields: [],
          requiredEnv: [],
          artifactReadiness: {
            mode: "none",
          },
        },
      },
    ];
  }

  return [];
}
