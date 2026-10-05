import { TaskExecutionError } from "@hooka/task-sdk";
import { randomUUID } from "node:crypto";
import { mkdir, unlink } from "node:fs/promises";
import { renameSync } from "node:fs";
import { isAbsolute, join, resolve } from "node:path";
import type { Account, App, ResultEntry, Snapshot, Subject } from "./contracts";
import { configSchema, offerSchema, snapshotSchema } from "./contracts";
import { failure } from "./errors";
import { matchProducts } from "./matching";
import { collectReport } from "./reports";
import type { PerformanceInput, SettlementInput } from "./contracts";
import { SharelinkProvider } from "./provider";
import { digest, SharelinkStore } from "./store";

type Env = Record<string, string | undefined>;
interface Context {
  app: App;
  account: Account;
  configPath: string;
  dbPath: string;
  resultsPath: string;
}
const ruleFingerprint = (app: App, subject: Subject) =>
  digest([app.accountId, app.subTagId, subject]);

/** Resolve trusted operator configuration; task callers cannot supply paths or credentials. */
async function context(appId: string, env: Env): Promise<Context> {
  const configPath = env["HOOKA_SHARELINK_CONFIG_PATH"];
  const dbPath = env["HOOKA_SHARELINK_DB_PATH"];
  const resultsPath = env["HOOKA_SHARELINK_RESULTS_PATH"];
  if (
    !configPath ||
    !dbPath ||
    !resultsPath ||
    ![configPath, dbPath, resultsPath].every(isAbsolute)
  )
    throw failure("configuration_paths");
  if (
    resolve(dbPath) === resolve(env["HOOKA_DB_PATH"] ?? "/data/hooka.sqlite") ||
    resolve(dbPath).startsWith(`${resolve(resultsPath)}/`) ||
    resolve(configPath).startsWith(`${resolve(resultsPath)}/`)
  )
    throw failure("private_path_overlap");
  const file = Bun.file(configPath);
  if (file.size > 2097152) throw failure("configuration_too_large");
  const parsed = configSchema.safeParse(await file.json());
  if (!parsed.success) throw failure("invalid_configuration");
  const app = parsed.data.apps.find((a) => a.appId === appId);
  if (!app) throw failure("unknown_app");
  const account = parsed.data.accounts.find(
    (a) => a.accountId === app.accountId,
  );
  if (!account) throw failure("unknown_account");
  return { app, account, configPath, dbPath, resultsPath };
}

/** Abort a running task if an operator replaced its configuration during an await. */
async function ensureCurrent(ctx: Context, env: Env): Promise<void> {
  const current = await context(ctx.app.appId, env);
  if (digest(current) !== digest(ctx))
    throw failure("configuration_changed", true);
}

/** Export only current rule fingerprints and unexpired offers, with explicit missing states. */
function snapshot(store: SharelinkStore, app: App): Snapshot {
  const now = Date.now();
  const entries: ResultEntry[] = app.subjects.map((subject) => {
    const empty: ResultEntry = {
      subjectId: subject.subjectId,
      ruleRevision: subject.revision,
      status: subject.enabled ? "pending" : "disabled",
      offer: null,
    };
    if (!subject.enabled) return empty;
    const result = store.result(
      app.appId,
      subject.subjectId,
      ruleFingerprint(app, subject),
    );
    if (!result) return empty;
    if (result.offer && result.offer.expiresAt <= now) return empty;
    return result;
  });
  return snapshotSchema.parse({
    schemaVersion: 1,
    appId: app.appId,
    appRevision: app.revision,
    generationId: randomUUID(),
    generatedAt: now,
    entries,
  });
}

/** Atomically replace the consumer file while fencing lease ownership inside a write transaction. */
async function publish(
  store: SharelinkStore,
  ctx: Context,
  env: Env,
  guard: () => void,
): Promise<{ ready: number; total: number }> {
  await ensureCurrent(ctx, env);
  guard();
  const data = snapshot(store, ctx.app);
  const directory = join(ctx.resultsPath, ctx.app.appId);
  await mkdir(directory, { recursive: true, mode: 0o755 });
  const temporary = join(directory, `.offers-${data.generationId}.tmp`);
  try {
    await Bun.write(temporary, `${JSON.stringify(data)}\n`, { mode: 0o644 });
    // Do not let a delayed worker overwrite another owner's output.
    await ensureCurrent(ctx, env);
    store.db
      .transaction(() => {
        guard();
        renameSync(temporary, join(directory, "offers.json"));
      })
      .immediate();
  } finally {
    await unlink(temporary).catch(() => {});
  }
  return {
    ready: data.entries.filter((entry) => entry.status === "ready").length,
    total: data.entries.length,
  };
}

/** Prefer reviewed manual mappings; only item-specific refusals advance automatic candidates. */
async function resolveSubject(
  subject: Subject,
  app: App,
  provider: SharelinkProvider,
  inspection: { pages: number; candidates: number; reason: string },
): Promise<ResultEntry> {
  const base = {
    subjectId: subject.subjectId,
    ruleRevision: subject.revision,
    offer: null,
  };
  if (!subject.enabled) return { ...base, status: "disabled" };
  const now = Date.now();
  const manual = subject.manual;
  if (manual && manual.reviewedAt <= now && manual.reviewUntil > now) {
    return {
      ...base,
      status: "ready",
      offer: offerSchema.parse({
        provider: "toss-sharelink",
        productId: manual.productId,
        title: manual.title,
        url: manual.url,
        source: "manual",
        checkedAt: manual.reviewedAt,
        expiresAt: Math.min(manual.reviewUntil, now + 15 * 60000),
      }),
    };
  }
  const categories = await provider.categories();
  const pinned = subject.pinnedProductId
    ? await provider.detail(subject.pinnedProductId)
    : null;
  const pageLimit = subject.pinnedProductId
    ? 1
    : (subject.maxCatalogPages ?? 1);
  const cursors = new Set<string>();
  const products = new Set<string>();
  let cursor: string | undefined;
  for (let pageIndex = 0; pageIndex < pageLimit; pageIndex++) {
    const page = subject.pinnedProductId
      ? { products: pinned ? [pinned.product] : [], nextCursor: null }
      : await provider.listPage(
          subject.categoryId,
          subject.catalogSource,
          cursor,
        );
    if (!subject.pinnedProductId) inspection.pages++;
    const candidates = matchProducts(
      page.products.filter((product) => !products.has(product.id)),
      categories,
      subject,
    );
    for (const product of page.products) products.add(product.id);
    for (const candidate of candidates) {
      if (inspection.candidates >= 3) break;
      inspection.candidates++;
      const fresh = pinned ?? (await provider.detail(candidate.id));
      if (
        !fresh ||
        fresh.expiresAt <= Date.now() + 60000 ||
        !matchProducts([fresh.product], categories, subject).length
      )
        continue;
      let url: string;
      try {
        url = await provider.issue(candidate.id, app.subTagId);
      } catch (error) {
        if (
          error instanceof TaskExecutionError &&
          error.code === "sharelink_item_unavailable"
        )
          continue;
        throw error;
      }
      const expiresAt = Math.min(fresh.expiresAt, candidate.endAt ?? Infinity);
      if (expiresAt <= Date.now() + 60000) continue;
      return {
        ...base,
        status: "ready",
        offer: offerSchema.parse({
          provider: "toss-sharelink",
          productId: fresh.product.id,
          title: fresh.product.title,
          url,
          source: "automatic",
          checkedAt: fresh.checkedAt,
          expiresAt,
        }),
      };
    }
    if (subject.pinnedProductId) {
      inspection.reason = "pinned-unavailable";
      break;
    }
    if (inspection.candidates >= 3) {
      inspection.reason = "candidate-limit";
      break;
    }
    if (!page.nextCursor) break;
    if (cursors.has(page.nextCursor)) throw failure("invalid_catalog_cursor");
    cursors.add(page.nextCursor);
    cursor = page.nextCursor;
    if (pageIndex + 1 === pageLimit) inspection.reason = "page-limit";
  }
  return { ...base, status: "no-match" };
}

/** Task payload contains identifiers only; rules, credentials and output paths are operator-controlled. */
export async function runSharelink(
  input:
    | { appId: string; subjectIds?: string[] }
    | PerformanceInput
    | SettlementInput,
  env: Env,
  dryRun: boolean,
  mode: "refresh" | "export" | "subtags" | "performance" | "settlement",
): Promise<unknown> {
  let store: SharelinkStore | undefined;
  try {
    const ctx = await context(input.appId, env);
    const selectedIds =
      "subjectIds" in input && input.subjectIds
        ? new Set(input.subjectIds)
        : undefined;
    const configuredSubjects = new Map(
      ctx.app.subjects.map((subject) => [subject.subjectId, subject]),
    );
    const subjects = selectedIds
      ? [...selectedIds].map((id) => {
          const subject = configuredSubjects.get(id);
          if (!subject) throw failure("unknown_subject");
          return subject;
        })
      : ctx.app.subjects;
    if (mode === "refresh" && subjects.length > 100)
      throw failure("batch_too_large");
    if (dryRun)
      return {
        schemaVersion: 1,
        appId: ctx.app.appId,
        mode,
        subjects: subjects.length,
        dryRun: true,
      };
    const accessKey = env[ctx.account.accessKeyEnv];
    const secretKey = env[ctx.account.secretKeyEnv];
    if (!accessKey?.trim() || !secretKey?.trim())
      throw failure("credentials_missing");
    store = await SharelinkStore.open(ctx.dbPath);
    const activeStore = store;
    store.bindAccount(ctx.account, accessKey);
    return await store.withAccount(ctx.account.accountId, async (guard) => {
      // All replicas must use the same app revision; stale configurations fail closed.
      guard();
      activeStore.bindApp(ctx.app);
      activeStore.prune();
      if (
        mode === "subtags" ||
        mode === "performance" ||
        mode === "settlement"
      ) {
        const provider = new SharelinkProvider(
          ctx.account,
          accessKey,
          secretKey,
          activeStore,
          guard,
        );
        if (mode === "subtags") {
          await provider.ensureSubTag(ctx.app.subTagId);
          return { schemaVersion: 1, appId: ctx.app.appId, registered: true };
        }
        const report = await collectReport(
          provider,
          ctx.app,
          input as PerformanceInput | SettlementInput,
          mode,
        );
        await ensureCurrent(ctx, env);
        guard();
        // Business metrics remain private. Never export them with the public offer snapshots.
        activeStore.put(
          ctx.account.accountId,
          `report:${ctx.app.appId}:${digest(input)}`,
          report,
          Date.now() + 90 * 86400000,
        );
        return report;
      }
      if (mode === "refresh") {
        const inspections: {
          subjectId: string;
          pages: number;
          candidates: number;
          reason: string;
        }[] = [];
        const provider = new SharelinkProvider(
          ctx.account,
          accessKey,
          secretKey,
          activeStore,
          guard,
        );
        // Immediately withdraw disabled/deleted/revised rules, including on a provider failure.
        await publish(activeStore, ctx, env, guard);
        try {
          for (const subject of subjects) {
            await ensureCurrent(ctx, env);
            guard();
            const fingerprint = ruleFingerprint(ctx.app, subject);
            activeStore.saveResult(
              ctx.app.appId,
              {
                subjectId: subject.subjectId,
                ruleRevision: subject.revision,
                status: subject.enabled ? "pending" : "disabled",
                offer: null,
              },
              fingerprint,
            );
            const inspection = {
              subjectId: subject.subjectId,
              pages: 0,
              candidates: 0,
              reason: "exhausted",
            };
            const result = await resolveSubject(
              subject,
              ctx.app,
              provider,
              inspection,
            );
            if (result.status !== "no-match") inspection.reason = result.status;
            inspections.push(inspection);
            await ensureCurrent(ctx, env);
            guard();
            activeStore.saveResult(ctx.app.appId, result, fingerprint);
          }
        } finally {
          await publish(activeStore, ctx, env, guard);
        }
        const counts = await publish(activeStore, ctx, env, guard);
        return {
          schemaVersion: 1,
          appId: ctx.app.appId,
          appRevision: ctx.app.revision,
          mode,
          ...counts,
          inspections,
        };
      }
      const counts = await publish(activeStore, ctx, env, guard);
      return {
        schemaVersion: 1,
        appId: ctx.app.appId,
        appRevision: ctx.app.revision,
        mode,
        ...counts,
      };
    });
  } catch (error) {
    if (error instanceof TaskExecutionError) throw error;
    // File/SQL/parser exceptions can contain private paths, config values, or credentials.
    throw failure("local_io_or_configuration");
  } finally {
    store?.close();
  }
}
