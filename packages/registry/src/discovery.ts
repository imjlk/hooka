import type {
  CompatibilityWebhookAdapter,
  CapabilityDefinition,
  HookaTask,
  TaskPackDefinition,
} from "@hooka/task-sdk";
import { existsSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";

interface RegistryManifest {
  kind: "capability" | "task-pack";
  export: string;
  webhookAdapters?: string[];
}

interface PackageJsonWithHookaRegistry {
  name?: string;
  hooka?: {
    registry?: {
      kind?: string;
      export?: string;
      webhookAdapters?: string[];
    };
  };
}

type PackageRegistryManifest =
  NonNullable<PackageJsonWithHookaRegistry["hooka"]>["registry"];

export interface RegistryDiscoveryResult {
  webhookAdapters: CompatibilityWebhookAdapter[];
  capabilities: CapabilityDefinition[];
  taskPacks: TaskPackDefinition[];
  errors: string[];
}

export async function discoverRegistryArtifacts(
  rootDir?: string,
): Promise<RegistryDiscoveryResult> {
  const resolvedRootDir = rootDir ?? resolveRegistryRoot(process.cwd());
  const webhookAdapters: CompatibilityWebhookAdapter[] = [];
  const capabilities: CapabilityDefinition[] = [];
  const taskPacks: TaskPackDefinition[] = [];
  const errors: string[] = [];
  const glob = new Bun.Glob("packages/*/package.json");
  const manifestPaths = Array.fromAsync(glob.scan({ cwd: resolvedRootDir }));

  for (const relativeManifestPath of (await manifestPaths).sort()) {
    const manifestPath = resolve(resolvedRootDir, relativeManifestPath);
    const packageJson =
      (await Bun.file(manifestPath).json()) as PackageJsonWithHookaRegistry;
    const registryManifest = packageJson.hooka?.registry;

    if (!registryManifest) {
      continue;
    }

    const manifestName = packageJson.name ?? relativeManifestPath;
    const parsedManifest = parseRegistryManifest(
      manifestName,
      registryManifest,
      errors,
    );

    if (!parsedManifest) {
      continue;
    }

    const modulePath = resolve(
      resolvedRootDir,
      relativeManifestPath.replace(/package\.json$/, "src/index.ts"),
    );

    try {
      const module = (await import(pathToFileURL(modulePath).href)) as Record<
        string,
        unknown
      >;
      const exported = module[parsedManifest.export];

      if (exported === undefined) {
        errors.push(
          `${manifestName} points to missing export "${parsedManifest.export}".`,
        );
        continue;
      }

      if (parsedManifest.kind === "capability") {
        if (!isCapabilityDefinition(exported)) {
          errors.push(
            `${manifestName} export "${parsedManifest.export}" is not a valid capability definition.`,
          );
          continue;
        }

        capabilities.push(exported);
        continue;
      }

      if (!isTaskPackDefinition(exported)) {
        errors.push(
          `${manifestName} export "${parsedManifest.export}" is not a valid task-pack definition.`,
        );
        continue;
      }

      taskPacks.push(exported);

      for (const adapterExport of parsedManifest.webhookAdapters ?? []) {
        const adapter = module[adapterExport];

        if (adapter === undefined) {
          errors.push(
            `${manifestName} points to missing webhook adapter export "${adapterExport}".`,
          );
          continue;
        }

        if (!isCompatibilityWebhookAdapter(adapter)) {
          errors.push(
            `${manifestName} export "${adapterExport}" is not a valid webhook adapter.`,
          );
          continue;
        }

        webhookAdapters.push(adapter);
      }
    } catch (error) {
      errors.push(
        `${manifestName} registry import failed: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }

  return {
    webhookAdapters,
    capabilities,
    taskPacks,
    errors,
  };
}

function resolveRegistryRoot(startDir: string): string {
  let current = resolve(startDir);

  while (true) {
    if (
      existsSync(join(current, "package.json")) &&
      existsSync(join(current, "packages"))
    ) {
      return current;
    }

    const parent = dirname(current);

    if (parent === current) {
      return startDir;
    }

    current = parent;
  }
}

function parseRegistryManifest(
  packageName: string,
  value: PackageRegistryManifest,
  errors: string[],
): RegistryManifest | null {
  if (!value || typeof value.export !== "string" || value.export.length === 0) {
    errors.push(`${packageName} has an invalid hooka.registry.export value.`);
    return null;
  }

  if (
    value.webhookAdapters !== undefined &&
    (!Array.isArray(value.webhookAdapters) ||
      value.webhookAdapters.some(
        (entry) => typeof entry !== "string" || entry.length === 0,
      ))
  ) {
    errors.push(
      `${packageName} has an invalid hooka.registry.webhookAdapters value.`,
    );
    return null;
  }

  if (value.kind !== "capability" && value.kind !== "task-pack") {
    errors.push(`${packageName} has an invalid hooka.registry.kind value.`);
    return null;
  }

  if (value.kind !== "task-pack" && value.webhookAdapters?.length) {
    errors.push(
      `${packageName} can only declare hooka.registry.webhookAdapters on task-pack packages.`,
    );
    return null;
  }

  return {
    kind: value.kind,
    export: value.export,
    webhookAdapters: value.webhookAdapters,
  };
}

function isCapabilityDefinition(value: unknown): value is CapabilityDefinition {
  if (!isRecord(value)) {
    return false;
  }

  return (
    typeof value.id === "string" &&
    typeof value.title === "string" &&
    typeof value.description === "string" &&
    Array.isArray(value.binaries) &&
    value.binaries.every((entry) => typeof entry === "string") &&
    isRecord(value.healthcheck) &&
    typeof value.healthcheck.command === "string"
  );
}

function isTaskPackDefinition(value: unknown): value is TaskPackDefinition {
  if (!isRecord(value)) {
    return false;
  }

  return (
    typeof value.id === "string" &&
    typeof value.title === "string" &&
    typeof value.description === "string" &&
    Array.isArray(value.tasks) &&
    value.tasks.every((task) => isHookaTask(task))
  );
}

function isCompatibilityWebhookAdapter(
  value: unknown,
): value is CompatibilityWebhookAdapter {
  if (!isRecord(value)) {
    return false;
  }

  return (
    typeof value.id === "string" &&
    typeof value.routePath === "string" &&
    typeof value.normalize === "function"
  );
}

function isHookaTask(value: unknown): value is HookaTask {
  if (!isRecord(value)) {
    return false;
  }

  return (
    typeof value.id === "string" &&
    typeof value.title === "string" &&
    Array.isArray(value.requires) &&
    value.requires.every((entry) => typeof entry === "string") &&
    isRecord(value.input) &&
    typeof value.input.parse === "function" &&
    isRecord(value.executor) &&
    typeof value.executor.kind === "string"
  );
}

function isRecord(value: unknown): value is Record<string, any> {
  return typeof value === "object" && value !== null;
}
