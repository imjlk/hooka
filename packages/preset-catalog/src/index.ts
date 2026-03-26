import {
  definePreset,
  type PresetDefinition,
  type PresetTier,
} from "@hooka/task-sdk";

export interface PlannedPresetCatalogEntry {
  id: string;
  title: string;
  description: string;
  tier: PresetTier;
  publicWorkerTag: string;
  notes?: string[];
}

export interface WorkerPresetBuildSpec {
  imageLabel: string;
  installedCapabilities: string;
  legacyImageTags: string[];
  publicWorkerTag: string;
  runtimeRole: string;
  targetName: string;
  features: string;
}

export const serverImageTag = "webhook-server";

export const corePreset = definePreset({
  id: "core",
  title: "Core",
  description: "Minimal worker runtime without extra operational tooling.",
  tier: "lean",
  imageTag: "core",
  publicWorkerTag: "core",
  capabilities: [],
  taskPacks: [],
  notes: ["Useful for registry-only environments or future custom flows."],
});

export const cfPagesPreset = definePreset({
  id: "cf-pages",
  aliases: ["cf-wrangler"],
  title: "Cloudflare Pages",
  description:
    "Lean worker image for shared-volume deploys and direct uploads to Cloudflare Pages.",
  tier: "lean",
  imageTag: "cf-pages",
  publicWorkerTag: "cf-pages",
  legacyImageTags: ["cf-wrangler", "wrangler-worker"],
  capabilities: ["wrangler"],
  taskPacks: ["@hooka/pack-cloudflare", "@hooka/pack-webhook-wrangler"],
});

export const wpOpsPreset = definePreset({
  id: "wp-ops",
  title: "WordPress Ops",
  description: "Lean worker image for wp-cli operations and export validation.",
  tier: "lean",
  imageTag: "wp-ops",
  publicWorkerTag: "wp-ops",
  capabilities: ["wpcli", "php-cli"],
  taskPacks: ["@hooka/pack-wordpress"],
});

export const wpWranglerPreset = definePreset({
  id: "wp-wrangler",
  aliases: ["webhook-wrangler"],
  title: "WordPress Wrangler",
  description:
    "Combo worker image that bundles WordPress operations with Cloudflare Pages deploys.",
  tier: "combo",
  imageTag: "wp-wrangler",
  publicWorkerTag: "wp-wrangler",
  legacyImageTags: ["webhook-wrangler"],
  capabilities: ["wrangler", "wpcli", "php-cli"],
  taskPacks: [
    "@hooka/pack-wordpress",
    "@hooka/pack-cloudflare",
    "@hooka/pack-webhook-wrangler",
  ],
});

export const activeWorkerPresets = [
  corePreset,
  cfPagesPreset,
  wpOpsPreset,
  wpWranglerPreset,
] satisfies PresetDefinition[];

export const plannedWorkerPresets = [
  {
    id: "http",
    title: "HTTP",
    description: "Lean worker for curl/jq driven outbound webhooks and APIs.",
    tier: "lean",
    publicWorkerTag: "http",
  },
  {
    id: "coolify-deploy",
    title: "Coolify Deploy",
    description: "Lean worker for Coolify deploy webhooks and API triggers.",
    tier: "lean",
    publicWorkerTag: "coolify-deploy",
  },
  {
    id: "cf-cache",
    title: "Cloudflare Cache",
    description: "Lean worker for safe Cloudflare cache purge tasks.",
    tier: "lean",
    publicWorkerTag: "cf-cache",
  },
  {
    id: "wp-content-export",
    title: "WordPress Content Export",
    description: "Lean worker for WordPress content export flows.",
    tier: "lean",
    publicWorkerTag: "wp-content-export",
  },
  {
    id: "wp-backup-db",
    title: "WordPress Database Backup",
    description: "Lean worker for database dump and backup flows.",
    tier: "lean",
    publicWorkerTag: "wp-backup-db",
  },
  {
    id: "rclone-sync",
    title: "rclone Sync",
    description: "Lean worker for remote object and cloud storage sync flows.",
    tier: "lean",
    publicWorkerTag: "rclone-sync",
  },
  {
    id: "wp-cache-safe",
    title: "WordPress Cache Safe",
    description: "Combo worker for WordPress cache operations and safe CDN purge.",
    tier: "combo",
    publicWorkerTag: "wp-cache-safe",
  },
  {
    id: "wp-backup-rclone",
    title: "WordPress Backup + rclone",
    description: "Combo worker for backup generation and remote sync.",
    tier: "combo",
    publicWorkerTag: "wp-backup-rclone",
  },
  {
    id: "wp-migrate",
    title: "WordPress Migrate",
    description: "Combo worker for WordPress migration and search-replace flows.",
    tier: "combo",
    publicWorkerTag: "wp-migrate",
  },
  {
    id: "site-bun-build-cf-pages",
    title: "Bun Build + Cloudflare Pages",
    description: "Combo worker for build-and-publish site pipelines.",
    tier: "combo",
    publicWorkerTag: "site-bun-build-cf-pages",
  },
  {
    id: "cf-r2-publisher",
    title: "Cloudflare R2 Publisher",
    description: "Combo worker for publishing artifacts to Cloudflare R2.",
    tier: "combo",
    publicWorkerTag: "cf-r2-publisher",
  },
  {
    id: "cf-images",
    title: "Cloudflare Images",
    description: "Combo worker for image upload and variant workflows.",
    tier: "combo",
    publicWorkerTag: "cf-images",
  },
  {
    id: "smoke-http",
    title: "Smoke HTTP",
    description: "Combo worker for post-deploy health checks and follow-up webhooks.",
    tier: "combo",
    publicWorkerTag: "smoke-http",
  },
  {
    id: "site-bun-build-coolify",
    title: "Bun Build + Coolify",
    description: "Combo worker for build and Coolify deploy flows.",
    tier: "combo",
    publicWorkerTag: "site-bun-build-coolify",
  },
  {
    id: "wp-multisite",
    title: "WordPress Multisite",
    description: "Combo worker for multisite-aware operations.",
    tier: "combo",
    publicWorkerTag: "wp-multisite",
  },
  {
    id: "git-mirror",
    title: "Git Mirror",
    description: "Combo worker for repository mirror and replication flows.",
    tier: "combo",
    publicWorkerTag: "git-mirror",
  },
  {
    id: "notify",
    title: "Notify",
    description: "Combo worker for notification fan-out and follow-up hooks.",
    tier: "combo",
    publicWorkerTag: "notify",
  },
] satisfies PlannedPresetCatalogEntry[];

export const wpBackupRclonePlannedPreset = plannedWorkerPresets.find(
  (preset) => preset.id === "wp-backup-rclone",
);

export function listActiveWorkerPresets(): PresetDefinition[] {
  return [...activeWorkerPresets];
}

export function listPlannedWorkerPresets(): PlannedPresetCatalogEntry[] {
  return [...plannedWorkerPresets];
}

export function getWorkerPresetCatalogEntry(
  presetId: string,
): PresetDefinition | undefined {
  return activeWorkerPresets.find((preset) => {
    return preset.id === presetId || (preset.aliases ?? []).includes(presetId);
  });
}

export function getWorkerPresetTags(preset: PresetDefinition): string[] {
  return [...new Set([preset.publicWorkerTag ?? preset.imageTag, ...(preset.legacyImageTags ?? [])])];
}

export function getWorkerPresetFeatures(preset: PresetDefinition): string {
  return preset.capabilities.length > 0 ? preset.capabilities.join(",") : "core";
}

export function getWorkerPresetInstalledCapabilities(
  preset: PresetDefinition,
): string {
  return preset.capabilities.join(",");
}

export function getWorkerPresetBuildSpec(
  presetId: string,
): WorkerPresetBuildSpec | undefined {
  const preset = getWorkerPresetCatalogEntry(presetId);

  if (!preset) {
    return undefined;
  }

  return {
    imageLabel: `hooka:${preset.publicWorkerTag ?? preset.imageTag}`,
    installedCapabilities: getWorkerPresetInstalledCapabilities(preset),
    legacyImageTags: preset.legacyImageTags ?? [],
    publicWorkerTag: preset.publicWorkerTag ?? preset.imageTag,
    runtimeRole: `worker:${preset.id}`,
    targetName: preset.id,
    features: getWorkerPresetFeatures(preset),
  };
}

export function renderDockerBakeHcl(registry = "ghcr.io/imjlk/hooka"): string {
  const registryRef = "${REGISTRY}";
  const workerTargets = activeWorkerPresets.map((preset) => {
    const tags = getWorkerPresetTags(preset)
      .map((tag) => `"${registryRef}:${tag}"`)
      .join(", ");

    return `target "${preset.id}" {
  inherits = ["base"]
  target = "worker-preset"
  args = {
    HOOKA_FEATURES = "${getWorkerPresetFeatures(preset)}"
    HOOKA_IMAGE_LABEL = "hooka:${preset.publicWorkerTag ?? preset.imageTag}"
    HOOKA_RUNTIME_ROLE = "worker:${preset.id}"
    HOOKA_INSTALLED_CAPABILITIES = "${getWorkerPresetInstalledCapabilities(preset)}"
  }
  tags = [${tags}]
}`;
  });

  return `variable "REGISTRY" {
  default = "${registry}"
}

target "base" {
  context = "."
  dockerfile = "docker/Dockerfile"
  platforms = ["linux/amd64", "linux/arm64"]
}

target "webhook-server" {
  inherits = ["base"]
  target = "webhook-server"
  tags = ["${registryRef}:${serverImageTag}"]
}

${workerTargets.join("\n\n")}

group "release" {
  targets = ["webhook-server", ${activeWorkerPresets
    .map((preset) => `"${preset.id}"`)
    .join(", ")}]
}
`;
}
