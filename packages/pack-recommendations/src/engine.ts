import { createHash } from "node:crypto";
import {
  candidateKey,
  evidenceKey,
  configSchema,
  modelSchema,
  requestSchema,
  resultSchema,
  DAY,
  type Candidate,
  type Config,
  type Model,
  type Request,
  type Result,
} from "./contracts";

const compare = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);
function canonical(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonical);
  if (value && typeof value === "object")
    return Object.fromEntries(
      Object.entries(value)
        .sort(([a], [b]) => compare(a, b))
        .map(([k, v]) => [k, canonical(v)]),
    );
  return value;
}
export const digest = (value: unknown) =>
  createHash("sha256")
    .update(JSON.stringify(canonical(value)))
    .digest("hex");
export function requestDigest(input: unknown): string {
  const request = requestSchema.parse(input);
  return digest({
    ...request,
    candidates: [...request.candidates].sort((a, b) =>
      compare(candidateKey(a), candidateKey(b)),
    ),
  });
}
const safeSum = (values: number[]) => {
  let total = 0;
  for (const value of values) {
    total += value;
    if (!Number.isSafeInteger(total))
      throw new Error("Evidence total exceeds safe integer range.");
  }
  return total;
};

type Stats = {
  n: number;
  c: number;
  apps: Map<string, number>;
  days: Set<number>;
};
const emptyStats = (): Stats => ({
  n: 0,
  c: 0,
  apps: new Map(),
  days: new Set(),
});
function addStats(
  index: Map<string, Stats>,
  key: string,
  row: Model["rows"][number],
) {
  const stats = index.get(key) ?? emptyStats();
  stats.n = safeSum([stats.n, row.exposures]);
  stats.c = safeSum([stats.c, row.clicks]);
  if (row.exposures > 0) {
    stats.apps.set(
      row.appId,
      safeSum([stats.apps.get(row.appId) ?? 0, row.exposures]),
    );
    stats.days.add(row.day);
  }
  index.set(key, stats);
}

export function resolveRequest(config: Config, request: Request, now: number) {
  if (
    !Number.isSafeInteger(now) ||
    now < 0 ||
    request.generatedAt > now ||
    request.expiresAt <= now
  )
    throw new Error("Request is expired or from the future.");
  const app = config.apps.find((a) => a.appId === request.appId);
  const policy = config.policies.find((p) => p.policyId === request.policyId);
  const context = app?.contexts.find((c) => c.contextId === request.contextId);
  if (
    !app ||
    app.appRevision !== request.appRevision ||
    !policy ||
    policy.version !== request.policyVersion ||
    !context ||
    context.measurementProfileId !== request.measurementProfileId
  )
    throw new Error("Unknown or stale request registration.");
  for (const candidate of request.candidates) {
    const subject = app.subjects.find(
      (s) => s.subjectId === candidate.subjectId,
    );
    if (
      !subject?.enabled ||
      subject.ruleRevision !== candidate.ruleRevision ||
      (candidate.entityRef && !subject.entityRefs.includes(candidate.entityRef))
    )
      throw new Error("Unknown, disabled or stale candidate.");
  }
  return { app, policy, context };
}

/** Pure scoring; evidence must originate from a registered backend, never an app client. */
export function scoreRecommendations(
  configInput: unknown,
  requestInput: unknown,
  modelInput: unknown,
  now = Date.now(),
): Result {
  const config = configSchema.parse(configInput);
  const request = requestSchema.parse(requestInput);
  const model = modelSchema.parse(modelInput);
  const { app, policy, context } = resolveRequest(config, request, now);
  if (model.generatedAt > now || now - model.generatedAt > DAY)
    throw new Error("Future or stale model generation.");
  validateModelRegistrations(config, model);
  const lastDay = Math.floor((model.generatedAt - 2 * DAY) / DAY) * DAY - DAY;
  const rows = model.rows.filter(
    (row) =>
      row.experiment === "training" &&
      row.day >= lastDay - 13 * DAY &&
      row.day <= lastDay,
  );
  const candidates = [...request.candidates].sort((a, b) =>
    compare(candidateKey(a), candidateKey(b)),
  );
  const subjects = new Map(
    config.apps.flatMap((a) =>
      a.subjects.map((s) => [`${a.appId}/${s.subjectId}`, s] as const),
    ),
  );
  const contexts = new Map(
    config.apps.flatMap((a) =>
      a.contexts.map((c) => [`${a.appId}/${c.contextId}`, c] as const),
    ),
  );
  const localStats = new Map<string, Stats>();
  const sharedStats = new Map<string, Stats>();
  for (const row of rows) {
    const registered = subjects.get(`${row.appId}/${row.subjectId}`);
    // Historical lineage stays in the model but is never silently relabeled.
    if (
      !registered?.enabled ||
      registered.ruleRevision !== row.ruleRevision ||
      registered.mappingVersion !== row.mappingVersion
    )
      continue;
    let localKey = row.subjectId;
    let sharedKey = registered.canonicalSubjectId
      ? JSON.stringify([
          registered.canonicalSubjectId,
          registered.mappingVersion,
        ])
      : undefined;
    if (request.kind === "product") {
      localKey = row.entityRef ?? "";
      sharedKey = row.entityRef;
    }
    if (
      row.appId === app.appId &&
      row.contextId === context.contextId &&
      row.measurementProfileId === context.measurementProfileId &&
      localKey
    )
      addStats(localStats, localKey, row);
    const otherContext = contexts.get(`${row.appId}/${row.contextId}`);
    if (
      sharedKey &&
      policy.sharing &&
      context.learningGroupId &&
      row.appId !== app.appId &&
      row.measurementProfileId === context.measurementProfileId &&
      otherContext?.learningGroupId === context.learningGroupId &&
      otherContext?.cohortId === context.cohortId
    )
      addStats(sharedStats, sharedKey, row);
  }
  const scores = candidates.map((candidate) => {
    const subject = subjects.get(`${app.appId}/${candidate.subjectId}`);
    if (!subject) throw new Error("Unknown candidate.");
    let localKey = candidate.subjectId;
    let sharedKey = subject.canonicalSubjectId
      ? JSON.stringify([subject.canonicalSubjectId, subject.mappingVersion])
      : undefined;
    if (request.kind === "product") {
      localKey = candidate.entityRef ?? "";
      sharedKey = candidate.entityRef;
    }
    const local = localStats.get(localKey) ?? emptyStats();
    const other = sharedKey
      ? (sharedStats.get(sharedKey) ?? emptyStats())
      : emptyStats();
    const shared =
      other.apps.size > 0 &&
      other.n >= policy.minSharedExposures &&
      other.days.size >= policy.minSharedDays &&
      (other.apps.size === 1 ||
        Math.max(...other.apps.values()) / other.n <= policy.maxAppShare);
    let mu = policy.alpha / (policy.alpha + policy.beta);
    let k = policy.alpha + policy.beta;
    if (shared) {
      mu = (policy.alpha + other.c) / (policy.alpha + policy.beta + other.n);
      k =
        other.apps.size === 1
          ? policy.singleAppStrength
          : policy.sharedStrength;
    }
    const score = (k * mu + local.c) / (k + local.n);
    let confidence: Result["entries"][number]["confidence"] = "prior";
    let reason: Result["entries"][number]["reason"] = policy.sharing
      ? "insufficient-shared-evidence"
      : "cold-start";
    if (shared) {
      confidence = "shared";
      reason = "shared-prior";
    }
    if (local.n > 0) {
      confidence = "local";
      reason = "local-evidence";
    }
    return { candidate, score, confidence, reason };
  });
  const total = scores.reduce((sum, r) => sum + r.score, 0);
  const ranked = [...scores].sort(
    (a, b) =>
      b.score - a.score ||
      compare(candidateKey(a.candidate), candidateKey(b.candidate)),
  );
  const inputDigest = requestDigest(request);
  return resultSchema.parse({
    schemaVersion: 1,
    requestId: request.requestId,
    decisionId: `d-${digest([inputDigest, config, { ...model, rows: [...model.rows].sort((a, b) => compare(evidenceKey(a), evidenceKey(b))) }]).slice(0, 60)}`,
    appId: app.appId,
    appRevision: app.appRevision,
    policyId: policy.policyId,
    policyVersion: policy.version,
    modelGenerationId: model.modelGenerationId,
    inputDigest,
    generatedAt: Math.max(request.generatedAt, model.generatedAt),
    expiresAt: request.expiresAt,
    contextId: context.contextId,
    measurementProfileId: context.measurementProfileId,
    kind: request.kind,
    seed: request.seed,
    samplerVersion: "sha256-counter-v1",
    reason: scores.length ? "scored" : "no-eligible-candidates",
    entries: scores.map((s) => ({
      ...s.candidate,
      weight:
        total > 0
          ? (1 - policy.epsilon) * (s.score / total) +
            policy.epsilon / scores.length
          : 1 / scores.length,
      rank: ranked.indexOf(s) + 1,
      confidence: s.confidence,
      reason: s.reason,
    })),
  });
}

export function validateModelRegistrations(config: Config, model: Model) {
  const subjects = new Map(
    config.apps.flatMap((a) =>
      a.subjects.map((s) => [`${a.appId}/${s.subjectId}`, s] as const),
    ),
  );
  const contexts = new Map(
    config.apps.flatMap((a) =>
      a.contexts.map((c) => [`${a.appId}/${c.contextId}`, c] as const),
    ),
  );
  const entities = new Set(config.entities.map((e) => e.entityRef));
  for (const row of model.rows) {
    const context = contexts.get(`${row.appId}/${row.contextId}`);
    const subject = subjects.get(`${row.appId}/${row.subjectId}`);
    if (
      !subject ||
      !context ||
      context.measurementProfileId !== row.measurementProfileId ||
      (row.entityRef && !entities.has(row.entityRef)) ||
      (row.entityRef &&
        subject.ruleRevision === row.ruleRevision &&
        subject.mappingVersion === row.mappingVersion &&
        !subject.entityRefs.includes(row.entityRef)) ||
      row.day + DAY > model.generatedAt - 2 * DAY
    )
      throw new Error("Unknown or unsealed evidence registration.");
  }
}

/** Deterministic weighted sampling without replacement, with conditional draw probabilities. */
export function sampleRecommendations(input: unknown, count: number) {
  const result = resultSchema.parse(input);
  if (!Number.isSafeInteger(count) || count < 0 || count > 1000)
    throw new Error("Sample count must be 0..1000.");
  const remaining = [...result.entries].sort((a, b) =>
    compare(candidateKey(a), candidateKey(b)),
  );
  const draws: { candidate: Candidate; probability: number; draw: number }[] =
    [];
  while (remaining.length && draws.length < count) {
    const total = remaining.reduce((n, r) => n + r.weight, 0);
    const hash = digest([
      result.samplerVersion,
      result.seed,
      result.decisionId,
      draws.length,
    ]);
    const uniform = Number.parseInt(hash.slice(0, 13), 16) / 2 ** 52;
    let threshold = uniform * (total || remaining.length);
    let index = remaining.length - 1;
    for (let i = 0; i < remaining.length; i++) {
      threshold -= total ? (remaining[i]?.weight ?? 0) : 1;
      if (threshold < 0) {
        index = i;
        break;
      }
    }
    const [chosen] = remaining.splice(index, 1);
    if (!chosen) throw new Error("Sampling failed.");
    const candidate: Candidate = {
      subjectId: chosen.subjectId,
      ruleRevision: chosen.ruleRevision,
      ...(chosen.entityRef ? { entityRef: chosen.entityRef } : {}),
    };
    draws.push({
      candidate,
      probability: total ? chosen.weight / total : 1 / (remaining.length + 1),
      draw: draws.length + 1,
    });
  }
  return {
    samplerVersion: result.samplerVersion,
    draws,
    shortfall: Math.max(0, count - draws.length),
  };
}

/** Consumers bind results to the exact request; no credentials or other-app metrics are returned. */
export function validateRecommendations(
  input: unknown,
  requestInput: unknown,
  now = Date.now(),
): Result | null {
  const parsed = resultSchema.safeParse(input),
    request = requestSchema.safeParse(requestInput);
  if (
    !parsed.success ||
    !request.success ||
    !Number.isSafeInteger(now) ||
    now < 0
  )
    return null;
  const r = parsed.data,
    q = request.data;
  if (
    r.inputDigest !== requestDigest(q) ||
    r.generatedAt > now ||
    r.generatedAt < q.generatedAt ||
    r.expiresAt <= now ||
    r.expiresAt > q.expiresAt ||
    r.requestId !== q.requestId ||
    r.appId !== q.appId ||
    r.appRevision !== q.appRevision ||
    r.policyId !== q.policyId ||
    r.policyVersion !== q.policyVersion ||
    r.contextId !== q.contextId ||
    r.measurementProfileId !== q.measurementProfileId ||
    r.kind !== q.kind ||
    r.seed !== q.seed ||
    r.entries.length !== q.candidates.length ||
    r.entries.some(
      (e) =>
        !q.candidates.some(
          (c) =>
            candidateKey(c) === candidateKey(e) &&
            c.ruleRevision === e.ruleRevision,
        ),
    )
  )
    return null;
  return r;
}
