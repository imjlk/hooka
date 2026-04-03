import { defineCommand, option } from "@bunli/core";
import {
  createAdminUiDevConfig,
  createCliConfig,
  createServerConfig,
  createWorkerConfig,
  resolveManifestSource,
  type EnvRecord,
  type ManifestSourceKind,
} from "@hooka/config";
import { loadInstalledCapabilities } from "@hooka/runner-core";
import { loadTargets } from "@hooka/targets";
import { booleanFlagSchema, resolveBooleanFlag } from "../lib/shared";

export interface ConfigReport {
  dbPath: string;
  manifestPath: string;
  targetsPath: string;
  manifestSourceKind: ManifestSourceKind;
  installedCapabilities: string[];
  webhookSecretConfigured: boolean;
  adminTokenConfigured: boolean;
  targets: string[];
  uiPort: number;
  uiApiOrigin: string;
  statusUrl: string;
}

export async function collectConfigReport(
  input: { cwd?: string; env?: EnvRecord } = {},
): Promise<ConfigReport> {
  const cwd = input.cwd ?? process.cwd();
  const env = input.env ?? (Bun.env as EnvRecord);
  const cliConfig = createCliConfig({
    cwd,
    env,
  });
  const serverConfig = createServerConfig({
    cwd,
    env,
  });
  const workerConfig = createWorkerConfig({
    cwd,
    env,
  });
  const uiConfig = createAdminUiDevConfig({
    env,
  });
  const manifestSource = resolveManifestSource({
    cwd,
    env,
  });
  const manifest = await loadInstalledCapabilities(workerConfig.manifestPath);
  const targets = await loadTargets(cliConfig.targetsPath);

  return {
    dbPath: cliConfig.dbPath,
    manifestPath: manifestSource.manifestPath,
    targetsPath: cliConfig.targetsPath,
    manifestSourceKind: manifestSource.kind,
    installedCapabilities: manifest.installed,
    webhookSecretConfigured: Boolean(serverConfig.webhookSecret),
    adminTokenConfigured: Boolean(serverConfig.adminToken),
    targets: targets.map((target) => target.id),
    uiPort: uiConfig.uiPort,
    uiApiOrigin: uiConfig.apiOrigin,
    statusUrl: `http://127.0.0.1:${serverConfig.port}`,
  };
}

export function createConfigCommand() {
  return defineCommand({
    name: "config",
    description: "Show resolved Hooka configuration and manifest precedence.",
    options: {
      json: option(booleanFlagSchema, {
        description: "Print raw JSON instead of a human-readable summary.",
      }),
    },
    handler: async ({ flags }) => {
      const json = resolveBooleanFlag(flags.json, "--json");
      const report = await collectConfigReport();

      if (json) {
        console.log(JSON.stringify(report, null, 2));
        return;
      }

      console.log(`DB Path: ${report.dbPath}`);
      console.log(
        `Manifest Source: ${formatManifestSourceKind(report.manifestSourceKind)}`,
      );
      console.log(`Manifest Path: ${report.manifestPath}`);
      console.log(`Targets Path: ${report.targetsPath}`);
      console.log(
        `Installed Capabilities: ${report.installedCapabilities.join(", ") || "(none)"}`,
      );
      console.log(
        `Webhook Secret: ${report.webhookSecretConfigured ? "configured" : "missing"}`,
      );
      console.log(
        `Admin Token: ${report.adminTokenConfigured ? "configured" : "missing"}`,
      );
      console.log(`Targets: ${report.targets.join(", ") || "(none)"}`);
      console.log(
        `UI: http://127.0.0.1:${report.uiPort} -> ${report.uiApiOrigin}`,
      );
      console.log(`Status URL: ${report.statusUrl}`);
      console.log(
        "Manifest precedence: HOOKA_INSTALLED_CAPABILITIES -> HOOKA_MANIFEST_PATH -> default .hooka/installed-capabilities.json",
      );
    },
  });
}

function formatManifestSourceKind(kind: ManifestSourceKind): string {
  switch (kind) {
    case "env-inline":
      return "env-inline (HOOKA_INSTALLED_CAPABILITIES)";
    case "manifest-explicit":
      return "manifest-explicit (HOOKA_MANIFEST_PATH)";
    case "manifest-default":
      return "manifest-default (.hooka/installed-capabilities.json)";
  }
}
