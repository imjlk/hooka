import {
  defaultWorkerHeartbeatIntervalMs,
  getWorkerFreshness,
} from "@hooka/config";
import { targetSchema } from "@hooka/contracts";
import {
  createTargetScaffold as createSharedTargetScaffold,
  type TargetScaffoldOverrides,
} from "@hooka/targets";

export type Summary = {
  generatedAt: string;
  counts: {
    tasks: number;
    capabilities: number;
    presets: number;
  };
  installedCapabilities: string[];
  workers: Array<{
    workerId: string;
    runtimeRole: string;
    installedCapabilities: string[];
    lastSeenAt: string;
    currentRunId: string | null;
  }>;
  tasks: Array<{
    id: string;
    title: string;
    requires: string[];
    available: boolean;
  }>;
  presets: Array<{
    id: string;
    tier?: "lean" | "combo";
    imageTag: string;
    publicWorkerTag?: string;
    coveredTasks: number;
    capabilities: string[];
  }>;
};

export type RunSummary = {
  id: string;
  taskId: string;
  targetId: string | null;
  source: string;
  status: string;
  summary: string | null;
  createdAt: string;
  attemptCount: number;
  maxAttempts: number;
  nextRetryAt: string | null;
  lastErrorCode: string | null;
};

export type RunDetail = RunSummary & {
  sourceEventId: string | null;
  errorText: string | null;
  queuedAt: string | null;
  startedAt: string | null;
  finishedAt: string | null;
  payload: unknown;
  result: {
    stdout?: string;
    stderr?: string;
    summary?: string;
    status: string;
  } | null;
  capabilitySnapshot: string[];
  workerId: string | null;
  leaseExpiresAt: string | null;
  events: Array<{
    id: string;
    type: string;
    message: string;
    createdAt: string;
    data?: unknown;
  }>;
};

export type Capability = {
  id: string;
  title: string;
  description: string;
  binaries: string[];
  requiredEnv?: Array<{
    match: "allOf" | "anyOf";
    names: string[];
    description: string;
    secret?: boolean;
  }>;
};

export type Target = {
  id: string;
  title: string;
  description?: string;
  taskId: string;
  presetId?: string;
  source: string;
  maxAttempts: number;
  defaultInput: Record<string, unknown>;
  policy: {
    allowedProjects: string[];
    allowedSourceRoots: string[];
    allowedDestinationPrefixes: string[];
    allowedBranches: string[];
    allowedOverrideFields: string[];
    requiredEnv?: Array<{
      match: "allOf" | "anyOf";
      names: string[];
      description: string;
      secret?: boolean;
    }>;
    artifactReadiness:
      | { mode: "none" }
      | {
          mode: "marker-file";
          markerFile: string;
          requiredFiles?: string[];
        }
      | { mode: "required-files"; requiredFiles: string[] }
      | {
          mode: "quiet-period";
          quietPeriodMs: number;
          recursive?: boolean;
          requiredFiles?: string[];
        };
  };
};

export type AuditEvent = {
  sequence: number;
  createdAt: string;
  category: "security" | "policy" | "targets";
  action: string;
  outcome: "rejected" | "created" | "updated" | "deleted";
  subjectType: string;
  subjectId: string | null;
  clientIp: string | null;
  requestPath: string | null;
  message: string;
  context?: unknown;
};

export type PresetPlan = {
  presetId: string;
  tier?: "lean" | "combo";
  imageTag: string;
  publicWorkerTag?: string;
  legacyImageTags: string[];
  capabilities: string[];
  requiredEnv: Array<{
    capabilityId: string;
    match: "allOf" | "anyOf";
    names: string[];
    description: string;
    secret?: boolean;
  }>;
  taskPacks: string[];
  coveredTasks: string[];
  missingCapabilitiesByTask: Record<string, string[]>;
};

export type PresetWithPlan = {
  id: string;
  title: string;
  description: string;
  tier?: "lean" | "combo";
  imageTag: string;
  publicWorkerTag?: string;
  capabilities: string[];
  plan?: PresetPlan;
};

export type RunFilters = {
  status?: string;
  taskId?: string;
  source?: string;
  limit?: number;
};

export type AuditFilters = {
  category?: AuditEvent["category"];
  outcome?: AuditEvent["outcome"];
  limit?: number;
};

export type WorkerHealth = {
  freshness: "healthy" | "stale";
  lastSeenAgeMs: number;
  lastSeenLabel: string;
};

export function buildRunQuery(filters: RunFilters): string {
  const params = new URLSearchParams();

  if (filters.limit) {
    params.set("limit", String(filters.limit));
  }

  if (filters.status) {
    params.set("status", filters.status);
  }

  if (filters.taskId) {
    params.set("taskId", filters.taskId);
  }

  if (filters.source) {
    params.set("source", filters.source);
  }

  const query = params.toString();
  return query.length > 0 ? `?${query}` : "";
}

export function deriveRunFilterOptions(
  summary: Summary,
  runs: RunSummary[],
): {
  taskIds: string[];
  sources: string[];
} {
  const taskIds = [...summary.tasks.map((task) => task.id)].sort();
  const sources = [...new Set(runs.map((run) => run.source))].sort();

  return {
    taskIds,
    sources,
  };
}

export function selectActiveRunId(
  runs: RunSummary[],
  currentRunId: string | null,
): string | null {
  if (runs.length === 0) {
    return null;
  }

  if (currentRunId && runs.some((run) => run.id === currentRunId)) {
    return currentRunId;
  }

  return runs[0]?.id ?? null;
}

export function formatCapabilityEnvRows(
  capabilities: Capability[],
  installedCapabilities: string[],
): Array<{
  capabilityId: string;
  description: string;
  mode: string;
  names: string[];
  secret: boolean;
}> {
  return capabilities
    .filter((capability) => installedCapabilities.includes(capability.id))
    .flatMap((capability) =>
      (capability.requiredEnv ?? []).map((requirement) => ({
        capabilityId: capability.id,
        description: requirement.description,
        mode: requirement.match === "allOf" ? "all" : "any",
        names: requirement.names,
        secret: requirement.secret ?? false,
      })),
    );
}

export function selectPreset(
  presets: PresetWithPlan[],
  currentPresetId: string | null,
): PresetWithPlan | null {
  if (presets.length === 0) {
    return null;
  }

  if (currentPresetId) {
    const selected = presets.find((preset) => preset.id === currentPresetId);
    if (selected) {
      return selected;
    }
  }

  return presets[0] ?? null;
}

export function selectTarget(
  targets: Target[],
  currentTargetId: string | null,
): Target | null {
  if (targets.length === 0) {
    return null;
  }

  if (currentTargetId) {
    const selected = targets.find((target) => target.id === currentTargetId);
    if (selected) {
      return selected;
    }
  }

  return targets[0] ?? null;
}

export function createTargetScaffold(
  templateId:
    | "shared-volume-pages"
    | "cache-purge-urls"
    | "rclone-copy-remote"
    | "export-verify"
    | "generic" = "generic",
  overrides: TargetScaffoldOverrides = {},
): Target {
  return createSharedTargetScaffold(templateId, overrides);
}

export function serializeTargetEditorValue(target: Target): string {
  return `${JSON.stringify(target, null, 2)}\n`;
}

export function parseTargetEditorValue(input: string):
  | {
      ok: true;
      target: Target;
    }
  | {
      ok: false;
      error: string;
    } {
  try {
    const raw = JSON.parse(input) as unknown;
    const parsed = targetSchema.safeParse(raw);

    if (!parsed.success) {
      return {
        ok: false,
        error: parsed.error.issues
          .map(
            (issue) => `${issue.path.join(".") || "target"}: ${issue.message}`,
          )
          .join("; "),
      };
    }

    return {
      ok: true,
      target: parsed.data as Target,
    };
  } catch (error) {
    return {
      ok: false,
      error: error instanceof Error ? error.message : String(error),
    };
  }
}

export function describeTargetEditorValidation(input: string): {
  ok: boolean;
  message: string;
} {
  const parsed = parseTargetEditorValue(input);

  if (!parsed.ok) {
    return {
      ok: false,
      message: parsed.error,
    };
  }

  return {
    ok: true,
    message: `Valid target ${parsed.target.id} for ${parsed.target.taskId}.`,
  };
}

export function describeWorkerHealth(
  worker: Summary["workers"][number],
  heartbeatIntervalMs = defaultWorkerHeartbeatIntervalMs,
  nowMs = Date.now(),
): WorkerHealth {
  const parsed = Date.parse(worker.lastSeenAt);
  const lastSeenAgeMs = Number.isNaN(parsed)
    ? Number.POSITIVE_INFINITY
    : Math.max(0, nowMs - parsed);

  return {
    freshness: getWorkerFreshness(
      worker.lastSeenAt,
      heartbeatIntervalMs,
      nowMs,
    ),
    lastSeenAgeMs,
    lastSeenLabel: formatRelativeAge(lastSeenAgeMs),
  };
}

export function formatRelativeAge(ageMs: number): string {
  if (!Number.isFinite(ageMs)) {
    return "unknown age";
  }

  if (ageMs < 1_000) {
    return "just now";
  }

  const seconds = Math.floor(ageMs / 1_000);

  if (seconds < 60) {
    return `${seconds}s ago`;
  }

  const minutes = Math.floor(seconds / 60);

  if (minutes < 60) {
    return `${minutes}m ago`;
  }

  const hours = Math.floor(minutes / 60);

  if (hours < 24) {
    return `${hours}h ago`;
  }

  return `${Math.floor(hours / 24)}d ago`;
}

export function summarizeAuditContext(context: unknown): string | null {
  if (context === undefined) {
    return null;
  }

  const serialized =
    typeof context === "string" ? context : JSON.stringify(context);

  if (!serialized || serialized.length === 0) {
    return null;
  }

  return serialized.length > 160
    ? `${serialized.slice(0, 157)}...`
    : serialized;
}
