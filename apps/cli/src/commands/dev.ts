import { defineCommand, option } from "@bunli/core";
import {
  createServerConfig,
  createWorkerConfig,
  getServerStartupIssues,
  type EnvRecord,
} from "@hooka/config";
import { installedCapabilitiesManifestSchema } from "@hooka/contracts";
import { listCapabilities } from "@hooka/registry";
import { findMissingCapabilityEnvRequirements } from "@hooka/runtime-contracts";
import {
  booleanFlagSchema,
  resolveBooleanFlag,
  resolveCliSourceRoot,
} from "../lib/shared";

export interface DevCommandSpec {
  name: "server" | "worker" | "ui";
  argv: string[];
}

export interface SpawnedDevProcess {
  exited: Promise<number>;
  kill(signal?: string | number): void;
  stdout: ReadableStream<Uint8Array> | null;
  stderr: ReadableStream<Uint8Array> | null;
}

export function createDevCommand() {
  return defineCommand({
    name: "dev",
    description:
      "Run the Hooka server, worker, and UI together for local development.",
    options: {
      "no-ui": option(booleanFlagSchema, {
        description: "Skip the Bun HMR admin UI process.",
      }),
    },
    handler: async ({ flags }) => {
      const noUi = resolveBooleanFlag(flags["no-ui"], "--no-ui");
      const issues = await validateDevSetup();

      if (issues.length > 0) {
        throw new Error(issues.join("\n"));
      }

      const exitCode = await runDevSession({
        repoRoot: resolveCliSourceRoot(),
        specs: createDevCommandSpecs({
          noUi,
        }),
      });

      if (exitCode !== 0) {
        process.exitCode = exitCode;
      }
    },
  });
}

export function createDevCommandSpecs(input: {
  noUi: boolean;
}): DevCommandSpec[] {
  const specs: DevCommandSpec[] = [
    {
      name: "server",
      argv: [process.execPath, "run", "dev:server"],
    },
    {
      name: "worker",
      argv: [process.execPath, "run", "dev:worker"],
    },
  ];

  if (!input.noUi) {
    specs.push({
      name: "ui",
      argv: [process.execPath, "run", "dev:ui"],
    });
  }

  return specs;
}

export async function validateDevSetup(
  input: { cwd?: string; env?: EnvRecord } = {},
): Promise<string[]> {
  const cwd = input.cwd ?? process.cwd();
  const env = input.env ?? (Bun.env as EnvRecord);
  const issues: string[] = [];
  const serverConfig = createServerConfig({
    cwd,
    env,
  });
  const workerConfig = createWorkerConfig({
    cwd,
    env,
  });

  issues.push(...getServerStartupIssues(serverConfig));

  if (!(await Bun.file(workerConfig.manifestPath).exists())) {
    issues.push(
      `Manifest not found at ${workerConfig.manifestPath}. Run "hooka init" or "hooka image install-features".`,
    );
  }

  const manifest = await loadInstalledCapabilitiesForEnv(
    workerConfig.manifestPath,
    env,
  );
  const missingEnv = findMissingCapabilityEnvRequirements(
    listCapabilities(),
    manifest.installed,
    env,
  );

  if (missingEnv.length > 0) {
    issues.push(
      `Worker runtime env missing: ${missingEnv
        .map(
          (entry) =>
            `${entry.capabilityId}:${entry.match}(${entry.missingNames.join(", ")})`,
        )
        .join(", ")}`,
    );
  }

  return issues;
}

export async function runDevSession(input: {
  repoRoot: string;
  specs: DevCommandSpec[];
  env?: Record<string, string | undefined>;
  spawnProcess?: (
    spec: DevCommandSpec,
    repoRoot: string,
    env: Record<string, string | undefined>,
  ) => SpawnedDevProcess;
  stdout?: (line: string) => void;
  stderr?: (line: string) => void;
}): Promise<number> {
  const env = input.env ?? (Bun.env as Record<string, string | undefined>);
  const stdout = input.stdout ?? console.log;
  const stderr = input.stderr ?? console.error;
  const spawnProcess =
    input.spawnProcess ??
    ((spec, repoRoot, childEnv) =>
      Bun.spawn(spec.argv, {
        cwd: repoRoot,
        env: childEnv,
        stdin: "inherit",
        stdout: "pipe",
        stderr: "pipe",
      }));
  const children = input.specs.map((spec) => {
    const child = spawnProcess(spec, input.repoRoot, env);
    const pumps = [
      pipePrefixedStream(child.stdout, `[${spec.name}]`, stdout),
      pipePrefixedStream(child.stderr, `[${spec.name}]`, stderr),
    ];

    return {
      spec,
      child,
      pumps,
    };
  });
  let stopReason: "signal" | "child-exit" | null = null;

  const stopAll = (reason: "signal" | "child-exit") => {
    if (stopReason) {
      return;
    }

    stopReason = reason;

    for (const entry of children) {
      entry.child.kill("SIGTERM");
    }
  };

  const cleanupSignals = registerDevSignals(() => {
    stopAll("signal");
  });
  const firstExit = await Promise.race(
    children.map(async (entry) => ({
      exitCode: await entry.child.exited,
    })),
  );

  if (!stopReason) {
    stopAll("child-exit");
  }

  await Promise.all(children.flatMap((entry) => entry.pumps));
  cleanupSignals();

  if (stopReason === "signal") {
    return 0;
  }

  return firstExit.exitCode === 0 ? 0 : firstExit.exitCode;
}

function registerDevSignals(onSignal: () => void): () => void {
  const handleSignal = () => {
    onSignal();
  };

  process.on("SIGINT", handleSignal);
  process.on("SIGTERM", handleSignal);

  return () => {
    process.off("SIGINT", handleSignal);
    process.off("SIGTERM", handleSignal);
  };
}

async function pipePrefixedStream(
  stream: ReadableStream<Uint8Array> | null,
  prefix: string,
  write: (line: string) => void,
): Promise<void> {
  if (!stream) {
    return;
  }

  const reader = stream.getReader();
  const decoder = new TextDecoder();
  let buffer = "";

  while (true) {
    const { done, value } = await reader.read();

    if (done) {
      break;
    }

    buffer += decoder.decode(value, {
      stream: true,
    });
    const lines = buffer.split("\n");
    buffer = lines.pop() ?? "";

    for (const line of lines) {
      if (line.length > 0) {
        write(`${prefix} ${line}`);
      }
    }
  }

  buffer += decoder.decode();

  if (buffer.length > 0) {
    write(`${prefix} ${buffer}`);
  }
}

async function loadInstalledCapabilitiesForEnv(
  manifestPath: string,
  env: EnvRecord,
) {
  const override = env["HOOKA_INSTALLED_CAPABILITIES"]?.trim();

  if (override) {
    return installedCapabilitiesManifestSchema.parse({
      image: env["HOOKA_RUNTIME_ROLE"] ?? "hooka:env-override",
      generatedAt: new Date().toISOString(),
      installed: override
        .split(",")
        .map((capability) => capability.trim())
        .filter(Boolean),
    });
  }

  const manifestFile = Bun.file(manifestPath);

  if (!(await manifestFile.exists())) {
    return installedCapabilitiesManifestSchema.parse({
      image: "hooka:dev",
      installed: [],
    });
  }

  return installedCapabilitiesManifestSchema.parse(await manifestFile.json());
}
