import { Database } from "bun:sqlite";
import { chmod, mkdir } from "node:fs/promises";
import { dirname } from "node:path";
import {
  configSchema,
  requestSchema,
  modelSchema,
  resultSchema,
  candidateKey,
  evidenceKey,
  DAY,
  type Config,
  type Model,
  type Result,
} from "./contracts";
import {
  aggregateSchema,
  manifestSchema,
  assignmentSchema,
  aggregateRowSchema,
  type Assignment,
} from "./measurement";
import {
  digest,
  scoreRecommendations,
  sampleRecommendations,
  validateRecommendations,
} from "./engine";

const APPLICATION_ID = 0x48524d31;
const keepDay = (now: number) => Math.floor(now / DAY) * DAY - 90 * DAY;
const validateNow = (now: number) => {
  if (!Number.isSafeInteger(now) || now < 0)
    throw new Error("Invalid timestamp.");
};
/** One local learning-group writer. Never use consumer, queue or credential DBs. */
export class RecommendationStore {
  private constructor(
    private readonly db: Database,
    private readonly readonly: boolean,
  ) {}
  static async open(path: string, readonly = false) {
    if (!readonly) await mkdir(dirname(path), { recursive: true, mode: 0o700 });
    const db = new Database(path, {
      readonly,
      create: !readonly,
      strict: true,
    });
    try {
      const application = db
        .query<{ application_id: number }, []>("PRAGMA application_id")
        .get()?.application_id;
      const version = db
        .query<{ user_version: number }, []>("PRAGMA user_version")
        .get()?.user_version;
      const tables = db
        .query<{ n: number }, []>(
          "SELECT count(*) n FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'",
        )
        .get()?.n;
      if (
        application !== APPLICATION_ID &&
        (readonly || application !== 0 || version !== 0 || tables !== 0)
      )
        throw new Error("Not a recommendation database.");
      if (application === APPLICATION_ID && version !== 1)
        throw new Error("Unsupported recommendation store version.");
      if (!readonly) {
        await chmod(path, 0o600);
        db.exec(
          "PRAGMA busy_timeout=5000; PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL;",
        );
        db.transaction(() => {
          db.exec(`
            CREATE TABLE IF NOT EXISTS rec_models(id TEXT PRIMARY KEY, config_digest TEXT NOT NULL, json TEXT NOT NULL, created_at INTEGER NOT NULL);
            CREATE TABLE IF NOT EXISTS rec_meta(key TEXT PRIMARY KEY, value TEXT NOT NULL);
            CREATE TABLE IF NOT EXISTS rec_decisions(id TEXT PRIMARY KEY, app_id TEXT NOT NULL, request_json TEXT NOT NULL, result_json TEXT NOT NULL, config_json TEXT NOT NULL, created_at INTEGER NOT NULL);
            CREATE TABLE IF NOT EXISTS rec_manifests(id TEXT NOT NULL, app_id TEXT NOT NULL, digest TEXT NOT NULL, json TEXT NOT NULL, created_at INTEGER NOT NULL, PRIMARY KEY(app_id,id));
            CREATE TABLE IF NOT EXISTS rec_assignments(id TEXT NOT NULL, app_id TEXT NOT NULL, producer_id TEXT NOT NULL, json TEXT NOT NULL, digest TEXT NOT NULL, created_at INTEGER NOT NULL, PRIMARY KEY(app_id,id));
            CREATE INDEX IF NOT EXISTS rec_assignment_decision ON rec_assignments(app_id,json_extract(json,'$.decisionId'),json_extract(json,'$.application'));
            CREATE TABLE IF NOT EXISTS rec_snapshots(app_id TEXT NOT NULL, producer_id TEXT NOT NULL, profile_id TEXT NOT NULL, day INTEGER NOT NULL, revision INTEGER NOT NULL, digest TEXT NOT NULL, json TEXT NOT NULL, created_at INTEGER NOT NULL, PRIMARY KEY(app_id,profile_id,day));
            CREATE INDEX IF NOT EXISTS rec_snapshot_day ON rec_snapshots(day);
            CREATE TABLE IF NOT EXISTS rec_tombstones(key TEXT PRIMARY KEY, created_at INTEGER NOT NULL);
            CREATE TABLE IF NOT EXISTS rec_registrations(kind TEXT NOT NULL, id TEXT NOT NULL, revision INTEGER NOT NULL, digest TEXT NOT NULL, json TEXT NOT NULL, PRIMARY KEY(kind,id,revision));
            PRAGMA application_id=${APPLICATION_ID}; PRAGMA user_version=1;
          `);
        }).immediate();
      }
      return new RecommendationStore(db, readonly);
    } catch (error) {
      db.close();
      throw error;
    }
  }
  close() {
    this.db.close();
  }
  /** Hold the SQLite writer lock around the final synchronous pointer commit. */
  commitPublication(action: () => void) {
    this.write(() => {
      const returned: unknown = action();
      if (returned && typeof returned === "object" && "then" in returned)
        throw new Error("Publication commit must be synchronous.");
    });
  }
  private write<T>(fn: () => T): T {
    if (this.readonly) throw new Error("Store is read-only.");
    return this.db.transaction(fn).immediate();
  }
  private owner(config: Config, appId: string, producerId: string) {
    const app = config.apps.find((a) => a.appId === appId);
    if (!app || app.producerId !== producerId)
      throw new Error("Unknown app producer.");
    return app;
  }
  private register(config: Config) {
    const rows = [
      ...config.apps.map((app) => ({
        kind: "app",
        id: app.appId,
        revision: app.appRevision,
        value: app,
      })),
      ...config.policies.map((policy) => ({
        kind: "policy",
        id: policy.policyId,
        revision: policy.version,
        value: policy,
      })),
      ...config.entities.map((entity) => ({
        kind: "entity",
        id: entity.entityRef,
        revision: 1,
        value: entity,
      })),
    ];
    for (const row of rows) {
      const existing = this.db
        .query<{ digest: string }, [string, string, number]>(
          "SELECT digest FROM rec_registrations WHERE kind=? AND id=? AND revision=?",
        )
        .get(row.kind, row.id, row.revision);
      const hash = digest(row.value);
      if (existing && existing.digest !== hash)
        throw new Error("Registration changed without a new revision.");
      if (row.kind === "app") {
        const latest = this.db
          .query<{ revision: number; json: string }, [string, string]>(
            "SELECT revision,json FROM rec_registrations WHERE kind=? AND id=? ORDER BY revision DESC LIMIT 1",
          )
          .get(row.kind, row.id);
        if (latest && latest.revision > row.revision)
          throw new Error("Stale app registration.");
        if (latest && latest.revision < row.revision) {
          const old = configSchema.shape.apps.element.parse(
            JSON.parse(latest.json),
          );
          const app = config.apps.find((a) => a.appId === row.id);
          if (!app || old.producerId !== app.producerId)
            throw new Error("Producer rebinding requires a new app identity.");
          const history = this.db
            .query<{ json: string }, [string]>(
              "SELECT json FROM rec_registrations WHERE kind='app' AND id=? ORDER BY revision DESC",
            )
            .all(row.id)
            .map((r) =>
              configSchema.shape.apps.element.parse(JSON.parse(r.json)),
            );
          const priorContexts = new Map<
            string,
            Config["apps"][number]["contexts"][number]
          >();
          const priorSubjects = new Map<
            string,
            Config["apps"][number]["subjects"][number]
          >();
          for (const past of history) {
            for (const context of past.contexts)
              if (!priorContexts.has(context.contextId))
                priorContexts.set(context.contextId, context);
            for (const subject of past.subjects)
              if (!priorSubjects.has(subject.subjectId))
                priorSubjects.set(subject.subjectId, subject);
          }
          for (const context of app.contexts) {
            const before = priorContexts.get(context.contextId);
            if (before && digest(before) !== digest(context))
              throw new Error(
                "Changed context semantics require a new context ID.",
              );
          }
          for (const subject of app.subjects) {
            const before = priorSubjects.get(subject.subjectId);
            if (
              before &&
              (subject.ruleRevision < before.ruleRevision ||
                subject.mappingVersion < before.mappingVersion ||
                (subject.canonicalSubjectId !== before.canonicalSubjectId &&
                  subject.mappingVersion <= before.mappingVersion))
            )
              throw new Error(
                "Changed subject intent requires a new mapping version.",
              );
          }
        }
      }
      this.db
        .query("INSERT OR IGNORE INTO rec_registrations VALUES(?,?,?,?,?)")
        .run(row.kind, row.id, row.revision, hash, JSON.stringify(row.value));
    }
    this.db
      .query(
        "INSERT INTO rec_meta VALUES('registration',?) ON CONFLICT(key) DO UPDATE SET value=excluded.value",
      )
      .run(JSON.stringify(config));
  }
  private decision(id: string, appId: string) {
    const row = this.db
      .query<
        { request_json: string; result_json: string; config_json: string },
        [string, string]
      >(
        "SELECT request_json,result_json,config_json FROM rec_decisions WHERE id=? AND app_id=?",
      )
      .get(id, appId);
    if (!row) throw new Error("Unknown decision.");
    return {
      request: requestSchema.parse(JSON.parse(row.request_json)),
      result: resultSchema.parse(JSON.parse(row.result_json)),
      config: configSchema.parse(JSON.parse(row.config_json)),
    };
  }
  ingestManifest(configInput: unknown, input: unknown, now = Date.now()) {
    validateNow(now);
    const config = configSchema.parse(configInput),
      manifest = manifestSchema.parse(input);
    this.owner(config, manifest.appId, manifest.producerId);
    if (manifest.generatedAt > now || manifest.generatedAt < now - 120 * DAY)
      throw new Error("Manifest timestamp outside retention.");
    const canonicalManifest = {
      ...manifest,
      assignments: [...manifest.assignments].sort((a, b) =>
        a.assignmentId < b.assignmentId ? -1 : 1,
      ),
    };
    const fingerprint = digest(canonicalManifest);
    return this.write(() => {
      this.register(config);
      const previous = this.db
        .query<{ digest: string }, [string, string]>(
          "SELECT digest FROM rec_manifests WHERE app_id=? AND id=?",
        )
        .get(manifest.appId, manifest.manifestId);
      if (previous) {
        if (previous.digest !== fingerprint)
          throw new Error("Conflicting immutable manifest.");
        return { status: "duplicate" };
      }
      const samplerGroups = new Map<string, Assignment[]>();
      const decisions = new Map<
        string,
        ReturnType<RecommendationStore["decision"]>
      >();
      const decisionFor = (id: string) => {
        const existing = decisions.get(id);
        if (existing) return existing;
        const decision = this.decision(id, manifest.appId);
        decisions.set(id, decision);
        return decision;
      };
      for (const assignment of manifest.assignments)
        if (assignment.application === "sampler") {
          const group = samplerGroups.get(assignment.decisionId) ?? [];
          group.push(assignment);
          samplerGroups.set(assignment.decisionId, group);
        }
      for (const [decisionId, assignments] of samplerGroups) {
        const result = decisionFor(decisionId).result;
        const stored = this.db
          .query<{ json: string }, [string, string]>(
            "SELECT json FROM rec_assignments WHERE app_id=? AND json_extract(json,'$.decisionId')=? AND json_extract(json,'$.application')='sampler'",
          )
          .all(manifest.appId, decisionId)
          .map((r) => assignmentSchema.parse(JSON.parse(r.json)));
        const incoming = new Set(assignments.map((a) => a.assignmentId));
        const combined = [
          ...stored.filter((a) => !incoming.has(a.assignmentId)),
          ...assignments,
        ];
        const expected = sampleRecommendations(result, combined.length);
        if (
          expected.shortfall ||
          new Set(combined.map(candidateKey)).size !== combined.length ||
          new Set(combined.map((a) => a.experiment)).size > 1 ||
          combined.some(
            (a) =>
              !expected.draws.some(
                (d) =>
                  candidateKey(d.candidate) === candidateKey(a) &&
                  Math.abs(d.probability - (a.appliedProbability ?? 0)) < 1e-12,
              ),
          )
        )
          throw new Error(
            "Sampler assignments must match the selected prefix.",
          );
        if (
          combined.some((a) => a.experiment === "holdout") &&
          result.entries.some(
            (e) => Math.abs(e.weight - 1 / result.entries.length) > 1e-12,
          )
        )
          throw new Error("Holdout sampling requires uniform weights.");
      }
      for (const assignment of manifest.assignments) {
        const decision = decisionFor(assignment.decisionId);
        if (
          decision.config.apps.find((a) => a.appId === manifest.appId)
            ?.producerId !== manifest.producerId
        )
          throw new Error("Decision producer mismatch.");
        if (
          decision.request.appRevision !== manifest.appRevision ||
          assignment.startsAt > manifest.generatedAt ||
          assignment.startsAt < decision.result.generatedAt ||
          assignment.startsAt >= decision.result.expiresAt ||
          assignment.contextId !== decision.request.contextId ||
          assignment.measurementProfileId !==
            decision.request.measurementProfileId
        )
          throw new Error(
            "Assignment does not match decision window or context.",
          );
        const candidate = decision.request.candidates.find(
          (c) =>
            candidateKey(c) === candidateKey(assignment) &&
            c.ruleRevision === assignment.ruleRevision,
        );
        const subject = decision.config.apps
          .find((a) => a.appId === manifest.appId)
          ?.subjects.find((s) => s.subjectId === assignment.subjectId);
        if (
          !candidate ||
          !subject ||
          subject.mappingVersion !== assignment.mappingVersion
        )
          throw new Error("Assignment lineage mismatch.");
        const prior = this.db
          .query<{ digest: string }, [string, string]>(
            "SELECT digest FROM rec_assignments WHERE app_id=? AND id=?",
          )
          .get(manifest.appId, assignment.assignmentId);
        const hash = digest(assignment);
        if (prior && prior.digest !== hash)
          throw new Error("Conflicting immutable assignment.");
        this.db
          .query("INSERT OR IGNORE INTO rec_assignments VALUES(?,?,?,?,?,?)")
          .run(
            assignment.assignmentId,
            manifest.appId,
            manifest.producerId,
            JSON.stringify(assignment),
            hash,
            now,
          );
      }
      this.db
        .query("INSERT INTO rec_manifests VALUES(?,?,?,?,?)")
        .run(
          manifest.manifestId,
          manifest.appId,
          fingerprint,
          JSON.stringify(canonicalManifest),
          now,
        );
      return { status: "applied" };
    });
  }
  private assignment(appId: string, id: string): Assignment {
    const row = this.db
      .query<{ json: string }, [string, string]>(
        "SELECT json FROM rec_assignments WHERE app_id=? AND id=?",
      )
      .get(appId, id);
    if (!row) throw new Error("Unknown assignment.");
    return assignmentSchema.parse(JSON.parse(row.json));
  }
  ingestAggregate(configInput: unknown, input: unknown, now = Date.now()) {
    validateNow(now);
    const config = configSchema.parse(configInput),
      snapshot = aggregateSchema.parse(input);
    const app = this.owner(config, snapshot.appId, snapshot.producerId);
    if (
      (!app.contexts.some(
        (c) => c.measurementProfileId === snapshot.measurementProfileId,
      ) &&
        !this.db
          .query<{ day: number }, [string, string]>(
            "SELECT day FROM rec_snapshots WHERE app_id=? AND profile_id=? LIMIT 1",
          )
          .get(snapshot.appId, snapshot.measurementProfileId)) ||
      snapshot.generatedAt > now ||
      snapshot.periodEnd > now ||
      snapshot.periodStart < keepDay(now)
    )
      throw new Error("Unknown profile, future period or pruned day.");
    const canonicalSnapshot = {
      ...snapshot,
      rows: [...snapshot.rows].sort((a, b) =>
        a.assignmentId < b.assignmentId ? -1 : 1,
      ),
    };
    const fingerprint = digest(canonicalSnapshot);
    return this.write(() => {
      this.register(config);
      for (const row of snapshot.rows) {
        const assignment = this.assignment(snapshot.appId, row.assignmentId);
        if (
          assignment.measurementProfileId !== snapshot.measurementProfileId ||
          assignment.endsAt <= snapshot.periodStart ||
          assignment.startsAt >= snapshot.periodEnd
        )
          throw new Error("Assignment does not overlap measurement period.");
      }
      const previous = this.db
        .query<
          { revision: number; digest: string; producer_id: string },
          [string, string, number]
        >(
          "SELECT revision,digest,producer_id FROM rec_snapshots WHERE app_id=? AND profile_id=? AND day=?",
        )
        .get(
          snapshot.appId,
          snapshot.measurementProfileId,
          snapshot.periodStart,
        );
      if (previous) {
        if (previous.producer_id !== snapshot.producerId)
          throw new Error("Conflicting producer ownership.");
        if (previous.revision > snapshot.revision) return { status: "stale" };
        if (previous.revision === snapshot.revision) {
          if (previous.digest !== fingerprint)
            throw new Error("Conflicting aggregate revision.");
          return { status: "duplicate" };
        }
      }
      this.db
        .query(
          "INSERT INTO rec_snapshots VALUES(?,?,?,?,?,?,?,?) ON CONFLICT(app_id,profile_id,day) DO UPDATE SET revision=excluded.revision,digest=excluded.digest,json=excluded.json,created_at=excluded.created_at",
        )
        .run(
          snapshot.appId,
          snapshot.producerId,
          snapshot.measurementProfileId,
          snapshot.periodStart,
          snapshot.revision,
          fingerprint,
          JSON.stringify(canonicalSnapshot),
          now,
        );
      return { status: "applied" };
    });
  }
  build(configInput: unknown, now = Date.now()): Model {
    validateNow(now);
    const config = configSchema.parse(configInput);
    return this.write(() => {
      const current = this.db
        .query<{ created_at: number }, []>(
          "SELECT created_at FROM rec_models WHERE id=(SELECT value FROM rec_meta WHERE key='current')",
        )
        .get();
      if (current && current.created_at > now)
        throw new Error("Model generation clock regressed.");
      this.register(config);
      const lastDay = Math.floor((now - 2 * DAY) / DAY) * DAY - DAY;
      const snapshots = this.db
        .query<
          {
            app_id: string;
            producer_id: string;
            day: number;
            assignment_json: string | null;
            observed_json: string;
          },
          [number, number]
        >(`
        SELECT s.app_id,s.producer_id,s.day,a.json AS assignment_json,r.value AS observed_json
        FROM rec_snapshots s JOIN json_each(s.json,'$.rows') r
        LEFT JOIN rec_assignments a ON a.app_id=s.app_id AND a.id=json_extract(r.value,'$.assignmentId')
        WHERE s.day>=? AND s.day<=? ORDER BY s.app_id,s.profile_id,s.day,a.id
      `)
        .iterate(lastDay - 13 * DAY, lastDay);
      const apps = new Map(config.apps.map((a) => [a.appId, a]));
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
      const index = new Map<string, Model["rows"][number]>();
      let scanned = 0;
      for (const stored of snapshots) {
        if (++scanned > 1_000_000)
          throw new Error(
            "Model source exceeds one million assignment rows; scope the learning group.",
          );
        const app = apps.get(stored.app_id);
        if (!app || app.producerId !== stored.producer_id) continue;
        if (!stored.assignment_json)
          throw new Error("Aggregate assignment evidence is missing.");
        const assignment = assignmentSchema.parse(
          JSON.parse(stored.assignment_json),
        );
        const observed = aggregateRowSchema.parse(
          JSON.parse(stored.observed_json),
        );
        const subject = subjects.get(`${app.appId}/${assignment.subjectId}`);
        const context = contexts.get(`${app.appId}/${assignment.contextId}`);
        if (
          !subject?.enabled ||
          subject.ruleRevision !== assignment.ruleRevision ||
          subject.mappingVersion !== assignment.mappingVersion ||
          context?.measurementProfileId !== assignment.measurementProfileId ||
          (assignment.entityRef &&
            !subject.entityRefs.includes(assignment.entityRef))
        )
          continue;
        const row: Model["rows"][number] = {
          appId: app.appId,
          subjectId: subject.subjectId,
          ruleRevision: assignment.ruleRevision,
          mappingVersion: assignment.mappingVersion,
          ...(assignment.entityRef ? { entityRef: assignment.entityRef } : {}),
          contextId: assignment.contextId,
          measurementProfileId: assignment.measurementProfileId,
          day: stored.day,
          experiment: assignment.experiment,
          exposures: 0,
          clicks: 0,
          dispatches: 0,
        };
        const key = evidenceKey(row),
          total = index.get(key) ?? row;
        for (const field of ["exposures", "clicks", "dispatches"] as const) {
          total[field] += observed[field];
          if (!Number.isSafeInteger(total[field]))
            throw new Error("Aggregate total overflow.");
        }
        index.set(key, total);
        if (index.size > 100_000)
          throw new Error(
            "Model exceeds 100,000 evidence rows; scope the learning group.",
          );
      }
      const rows = [...index.values()].sort((a, b) =>
        evidenceKey(a) < evidenceKey(b) ? -1 : 1,
      );
      const model = modelSchema.parse({
        schemaVersion: 1,
        modelGenerationId: `m-${digest([config, now, rows]).slice(0, 60)}`,
        generatedAt: now,
        rows,
      });
      this.db
        .query("INSERT OR IGNORE INTO rec_models VALUES(?,?,?,?)")
        .run(
          model.modelGenerationId,
          digest(config),
          JSON.stringify(model),
          now,
        );
      this.db
        .query(
          "INSERT INTO rec_meta VALUES('current',?) ON CONFLICT(key) DO UPDATE SET value=excluded.value",
        )
        .run(model.modelGenerationId);
      return model;
    });
  }
  plan(configInput: unknown, requestInput: unknown, now = Date.now()): Result {
    const config = configSchema.parse(configInput);
    const row = this.db
      .query<{ json: string; config_digest: string }, []>(
        "SELECT json,config_digest FROM rec_models WHERE id=(SELECT value FROM rec_meta WHERE key='current')",
      )
      .get();
    if (!row || row.config_digest !== digest(config))
      throw new Error("Build a model for the current registration first.");
    return scoreRecommendations(
      config,
      requestInput,
      JSON.parse(row.json),
      now,
    );
  }
  recordDecision(
    configInput: unknown,
    requestInput: unknown,
    now = Date.now(),
    expectedModelGenerationId?: string,
  ) {
    const config = configSchema.parse(configInput),
      request = requestSchema.parse(requestInput);
    return this.write(() => {
      this.register(config);
      const result = this.plan(config, request, now);
      if (
        expectedModelGenerationId !== undefined &&
        result.modelGenerationId !== expectedModelGenerationId
      )
        throw new Error("Expected recommendation model is no longer current.");
      if (!validateRecommendations(result, request, now))
        throw new Error("Invalid planned result.");
      this.db
        .query("INSERT OR IGNORE INTO rec_decisions VALUES(?,?,?,?,?,?)")
        .run(
          result.decisionId,
          result.appId,
          JSON.stringify(request),
          JSON.stringify(result),
          JSON.stringify(config),
          now,
        );
      return result;
    });
  }
  status(now = Date.now()) {
    validateNow(now);
    const model = this.db
      .query<{ id: string; created_at: number; config_digest: string }, []>(
        "SELECT id,created_at,config_digest FROM rec_models WHERE id=(SELECT value FROM rec_meta WHERE key='current')",
      )
      .get();
    const registration = this.db
      .query<{ value: string }, []>(
        "SELECT value FROM rec_meta WHERE key='registration'",
      )
      .get();
    const config = registration
      ? configSchema.parse(JSON.parse(registration.value))
      : null;
    const configurationCurrent = Boolean(
      config && model?.config_digest === digest(config),
    );
    const lastDay = Math.floor((now - 2 * DAY) / DAY) * DAY - DAY;
    const coverage =
      config?.apps.flatMap((app) =>
        [...new Set(app.contexts.map((c) => c.measurementProfileId))].map(
          (profileId) => {
            const days = this.db
              .query<{ day: number }, [string, string, number, number]>(
                "SELECT day FROM rec_snapshots WHERE app_id=? AND profile_id=? AND day>=? AND day<=? ORDER BY day",
              )
              .all(app.appId, profileId, lastDay - 13 * DAY, lastDay);
            return {
              appId: app.appId,
              measurementProfileId: profileId,
              sealedDays: days.length,
              missingDays: 14 - days.length,
              latestDay: days.at(-1)?.day ?? null,
            };
          },
        ),
      ) ?? [];
    const counts = Object.fromEntries(
      ["rec_models", "rec_decisions", "rec_assignments", "rec_snapshots"].map(
        (table) => [
          table,
          this.db
            .query<{ n: number }, []>(`SELECT count(*) n FROM ${table}`)
            .get()?.n ?? 0,
        ],
      ),
    );
    return {
      schemaVersion: 1,
      counts,
      currentModel: model?.id ?? null,
      configurationCurrent,
      coverage,
      modelFresh: Boolean(
        configurationCurrent &&
          model &&
          model.created_at <= now &&
          now - model.created_at <= DAY,
      ),
    };
  }
  prune(now = Date.now()) {
    validateNow(now);
    return this.write(() => {
      const expired = this.db
        .query<{ app_id: string; profile_id: string; day: number }, [number]>(
          "SELECT app_id,profile_id,day FROM rec_snapshots WHERE day<?",
        )
        .all(keepDay(now));
      for (const row of expired)
        this.db
          .query("INSERT OR IGNORE INTO rec_tombstones VALUES(?,?)")
          .run(digest(row), now);
      this.db.query("DELETE FROM rec_snapshots WHERE day<?").run(keepDay(now));
      for (const table of [
        "rec_models",
        "rec_decisions",
        "rec_manifests",
        "rec_assignments",
        "rec_tombstones",
      ])
        this.db
          .query(`DELETE FROM ${table} WHERE created_at<?`)
          .run(now - 120 * DAY);
      return { prunedDays: expired.length };
    });
  }
}
