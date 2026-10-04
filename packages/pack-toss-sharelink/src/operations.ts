import { Database } from "bun:sqlite";
import { join } from "node:path";
import {
  configSchema,
  snapshotSchema,
  idSchema,
  type App,
  type Snapshot,
} from "./contracts";
import { digest, nextKstDay } from "./store";

export type SharelinkConfig = ReturnType<typeof configSchema.parse>;

/** Offline validation deliberately does not resolve secret environment values. */
export async function readSharelinkConfig(
  path: string,
): Promise<SharelinkConfig> {
  const file = Bun.file(path);
  if (file.size > 2097152) throw new Error("Sharelink config exceeds 2 MiB.");
  const parsed = configSchema.safeParse(await file.json());
  if (!parsed.success)
    throw new Error(
      "Invalid Sharelink configuration. Check the v1 config schema.",
    );
  return parsed.data;
}

export async function readSharelinkSnapshot(
  root: string,
  appId: string,
): Promise<Snapshot | null> {
  // Paths come from validated operator config, not arbitrary app request input.
  idSchema.parse(appId);
  const file = Bun.file(join(root, appId, "offers.json"));
  if (!(await file.exists())) return null;
  if (file.size > 8388608) throw new Error("Sharelink snapshot exceeds 8 MiB.");
  return snapshotSchema.parse(await file.json());
}

/** Open an existing private store read-only; never initialize/migrate it for status. */
export function readSharelinkAccounts(
  path: string,
  config: SharelinkConfig,
  now = Date.now(),
) {
  const db = new Database(path, { readonly: true, strict: true });
  try {
    if (
      db.query<{ user_version: number }, []>("PRAGMA user_version").get()
        ?.user_version !== 1
    )
      throw new Error("Unsupported Sharelink store version.");
    return config.accounts.map((account) => {
      const state = db
        .query<{ blocked_until: number; lease_until: number }, [string]>(
          "SELECT blocked_until,lease_until FROM sharelink_accounts WHERE id=?",
        )
        .get(account.accountId);
      const budget = db
        .query<
          {
            products: number;
            links: number;
            product_limit: number;
            link_limit: number;
          },
          [string, number]
        >(
          "SELECT products,links,product_limit,link_limit FROM sharelink_budget WHERE account_id=? AND day_end=?",
        )
        .get(account.accountId, nextKstDay(now));
      return {
        accountId: account.accountId,
        blockedUntil: state?.blocked_until ?? 0,
        leasedUntil: state?.lease_until ?? 0,
        resetAt: nextKstDay(now),
        remainingProducts: Math.max(
          0,
          Math.min(
            account.productBudget,
            budget?.product_limit ?? account.productBudget,
          ) - (budget?.products ?? 0),
        ),
        remainingLinks: Math.max(
          0,
          Math.min(
            account.linkBudget,
            budget?.link_limit ?? account.linkBudget,
          ) - (budget?.links ?? 0),
        ),
      };
    });
  } finally {
    db.close();
  }
}
export type AccountStatus = ReturnType<typeof readSharelinkAccounts>[number];

export interface RefreshJob {
  taskId: "toss-sharelink.refresh" | "toss-sharelink.export";
  input: { schemaVersion: 1; appId: string; subjectIds?: string[] };
  sourceEventId: string;
  appId: string;
}

/** Deterministic, bounded batches: repeated ticks in a time bucket use the same event IDs. */
export function planSharelinkRefresh(
  config: SharelinkConfig,
  statuses: AccountStatus[] = [],
  options: {
    appId?: string;
    now?: number;
    batchSize?: number;
    periodMinutes?: number;
  } = {},
) {
  const now = options.now ?? Date.now();
  const size = options.batchSize ?? 25;
  const period = options.periodMinutes ?? 5;
  if (
    !Number.isInteger(size) ||
    size < 1 ||
    size > 100 ||
    !Number.isInteger(period) ||
    period < 1 ||
    period > 5 ||
    !Number.isSafeInteger(now) ||
    now < 0
  )
    throw new Error(
      "Batch size must be 1..100 and period must be 1..5 minutes.",
    );
  if (options.appId && !config.apps.some((app) => app.appId === options.appId))
    throw new Error("Unknown app.");
  const jobs: RefreshJob[] = [];
  const skipped: { appId: string; reason: string }[] = [];
  for (const app of config.apps.filter(
    (app) => !options.appId || app.appId === options.appId,
  )) {
    const state = statuses.find((item) => item.accountId === app.accountId);
    const stopped =
      state &&
      (state.blockedUntil > now ||
        state.remainingProducts === 0 ||
        state.remainingLinks === 0);
    if (stopped)
      skipped.push({
        appId: app.appId,
        reason: state.blockedUntil > now ? "account-cooldown" : "daily-budget",
      });
    const subjects = app.subjects
      .filter(
        (subject) =>
          subject.enabled &&
          (!stopped ||
            (subject.manual &&
              subject.manual.reviewedAt <= now &&
              subject.manual.reviewUntil > now)),
      )
      .map((subject) => subject.subjectId)
      .sort();
    const buckets = Array.from(
      { length: Math.ceil(subjects.length / size) },
      (_, index) => subjects.slice(index * size, (index + 1) * size),
    );
    // Export also withdraws removed/disabled rules while automatic work is paused.
    const inputs = buckets.length ? buckets : [undefined];
    for (const subjectIds of inputs) {
      const taskId = subjectIds
        ? "toss-sharelink.refresh"
        : "toss-sharelink.export";
      const input = {
        schemaVersion: 1 as const,
        appId: app.appId,
        ...(subjectIds ? { subjectIds } : {}),
      };
      jobs.push({
        taskId,
        appId: app.appId,
        input,
        sourceEventId: `sharelink:${digest([app, taskId, subjectIds, period, Math.floor(now / (period * 60000))])}`,
      });
    }
  }
  return { schemaVersion: 1, jobs, skipped };
}

/** App summaries contain no credentials, cached OAuth values or financial reports. */
export function summarizeSharelinkApp(
  app: App,
  snapshot: Snapshot | null,
  now = Date.now(),
) {
  const current =
    snapshot?.appId === app.appId &&
    snapshot.appRevision === app.revision &&
    snapshot.generatedAt <= now &&
    new Set(snapshot.entries.map((entry) => entry.subjectId)).size ===
      snapshot.entries.length;
  const counts = {
    ready: 0,
    expired: 0,
    pending: 0,
    disabled: 0,
    "no-match": 0,
  };
  for (const subject of app.subjects) {
    if (!subject.enabled) {
      counts.disabled++;
      continue;
    }
    const entry = current
      ? snapshot.entries.find(
          (item) =>
            item.subjectId === subject.subjectId &&
            item.ruleRevision === subject.revision,
        )
      : undefined;
    if (!entry) {
      counts.pending++;
      continue;
    }
    if (entry.offer && entry.offer.checkedAt > now) counts.pending++;
    else if (entry.offer && entry.offer.expiresAt <= now) counts.expired++;
    else counts[entry.status]++;
  }
  return {
    appId: app.appId,
    revision: app.revision,
    snapshotCurrent: !!current,
    generatedAt: snapshot?.generatedAt ?? null,
    counts,
  };
}
