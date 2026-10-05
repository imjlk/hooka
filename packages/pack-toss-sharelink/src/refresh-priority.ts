import { z } from "zod";
import {
  idSchema,
  configSchema,
  snapshotSchema,
  type Subject,
} from "./contracts";
import { digest, nextKstDay } from "./store";
import {
  worksetSchema,
  type SharelinkConfig,
  type AccountStatus,
} from "./operations";

const integer = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER);
const revision = integer.min(1);
export const refreshDemandSchema = z
  .object({
    schemaVersion: z.literal(1),
    generatedAt: integer,
    expiresAt: integer,
    seed: z.string().min(1).max(128),
    policy: z
      .object({
        policyId: idSchema.default("refresh-priority"),
        version: revision.default(1),
        maxSubjectsPerApp: integer.min(1).max(1000).default(25),
        explorationFraction: z.number().finite().min(0).max(0.5).default(0.2),
        urgentWithinMs: integer.max(900000).default(300000),
        maxWaitMs: integer.min(60000).max(86400000).default(86400000),
        accountShares: z
          .array(
            z
              .object({
                accountId: idSchema,
                apps: z
                  .array(
                    z
                      .object({
                        appId: idSchema,
                        weight: integer.min(1).max(100),
                      })
                      .strict(),
                  )
                  .min(1)
                  .max(100)
                  .refine(
                    (rows) =>
                      new Set(rows.map((r) => r.appId)).size === rows.length,
                  ),
              })
              .strict(),
          )
          .max(100)
          .refine(
            (rows) =>
              new Set(rows.map((r) => r.accountId)).size === rows.length,
          )
          .default([]),
      })
      .strict()
      .default({
        policyId: "refresh-priority",
        version: 1,
        maxSubjectsPerApp: 25,
        explorationFraction: 0.2,
        urgentWithinMs: 300000,
        maxWaitMs: 86400000,
        accountShares: [],
      }),
    apps: z
      .array(
        z
          .object({
            appId: idSchema,
            appRevision: revision,
            contextId: idSchema,
            measurementProfileId: idSchema,
            subjects: z
              .array(
                z
                  .object({
                    subjectId: idSchema,
                    ruleRevision: revision,
                    estimatedReach: integer.max(1000000000),
                  })
                  .strict(),
              )
              .max(1000)
              .refine(
                (rows) =>
                  new Set(rows.map((r) => r.subjectId)).size === rows.length,
              ),
          })
          .strict(),
      )
      .min(1)
      .max(100)
      .refine((rows) => new Set(rows.map((r) => r.appId)).size === rows.length),
  })
  .strict()
  .refine(
    (v) =>
      v.expiresAt > v.generatedAt && v.expiresAt - v.generatedAt <= 86400000,
  );
export type RefreshDemand = z.infer<typeof refreshDemandSchema>;
type Candidate = {
  subject: Subject;
  reach: number;
  expiresAt: number | null;
  urgent: boolean;
  overdue: boolean;
  manual: boolean;
  tie: string;
};

/** Cold-cache upper estimates match existing provider reservations; cache reuse can only reduce them. */
export function estimateRefreshCost(subject: Subject, now: number) {
  if (
    subject.manual &&
    subject.manual.reviewedAt <= now &&
    subject.manual.reviewUntil > now
  )
    return { products: 0, links: 0 };
  return {
    products: subject.pinnedProductId
      ? 1
      : 30 * (subject.maxCatalogPages ?? 1) + 3,
    links: subject.pinnedProductId ? 1 : 3,
  };
}

/** Shares are preview allocations, never budget reservations or cross-queue dispatch guarantees. */
export function previewRefreshPriority(
  configInput: SharelinkConfig,
  demandInput: unknown,
  snapshotsInput: unknown[] = [],
  statuses: AccountStatus[] = [],
  now = Date.now(),
) {
  const config = configSchema.parse(configInput),
    demand = refreshDemandSchema.parse(demandInput);
  if (
    !Number.isSafeInteger(now) ||
    now < 0 ||
    demand.generatedAt > now ||
    demand.expiresAt <= now
  )
    throw Error("Expired or future refresh demand.");
  for (const asked of demand.apps) {
    const app = config.apps.find((a) => a.appId === asked.appId);
    if (
      !app ||
      app.revision !== asked.appRevision ||
      asked.subjects.some(
        (s) =>
          !app.subjects.some(
            (r) =>
              r.enabled &&
              r.subjectId === s.subjectId &&
              r.revision === s.ruleRevision,
          ),
      )
    )
      throw Error("Unknown, disabled or stale demand registration.");
  }
  for (const share of demand.policy.accountShares) {
    const members = config.apps.filter((a) => a.accountId === share.accountId);
    if (
      !config.accounts.some((a) => a.accountId === share.accountId) ||
      share.apps.length !== members.length ||
      share.apps.some((a) => !members.some((m) => m.appId === a.appId))
    )
      throw Error(
        "Account shares require all configured app members exactly once.",
      );
  }
  if (new Set(statuses.map((s) => s.accountId)).size !== statuses.length)
    throw Error("Duplicate account status.");
  for (const s of statuses) {
    const account = config.accounts.find((a) => a.accountId === s.accountId);
    if (
      !account ||
      ![
        s.blockedUntil,
        s.leasedUntil,
        s.resetAt,
        s.remainingProducts,
        s.remainingLinks,
      ].every((v) => Number.isSafeInteger(v) && v >= 0) ||
      s.resetAt !== nextKstDay(now) ||
      s.remainingProducts > account.productBudget ||
      s.remainingLinks > account.linkBudget
    )
      throw Error("Invalid or stale account budget status.");
  }
  const snapshots = snapshotsInput.map((s) => snapshotSchema.parse(s));
  if (
    new Set(snapshots.map((s) => s.appId)).size !== snapshots.length ||
    snapshots.some((s) => !config.apps.some((a) => a.appId === s.appId))
  )
    throw Error("Unknown or duplicate offer snapshot.");
  const accounts = config.accounts.map((account) => {
    const status = statuses.find((s) => s.accountId === account.accountId),
      members = config.apps.filter((a) => a.accountId === account.accountId);
    const shares =
      demand.policy.accountShares.find((s) => s.accountId === account.accountId)
        ?.apps ?? members.map((a) => ({ appId: a.appId, weight: 1 }));
    const total = shares.reduce((n, s) => n + s.weight, 0),
      products = status?.remainingProducts ?? account.productBudget,
      links = status?.remainingLinks ?? account.linkBudget;
    return {
      accountId: account.accountId,
      budgetEvidence: status ? "observed" : "configured-upper-bound",
      remainingProducts: products,
      remainingLinks: links,
      blockedUntil: status?.blockedUntil ?? 0,
      leasedUntil: status?.leasedUntil ?? 0,
      shares: shares.map((s) => ({
        appId: s.appId,
        weight: s.weight,
        productAllowance: Math.floor((products * s.weight) / total),
        linkAllowance: Math.floor((links * s.weight) / total),
      })),
    };
  });
  const expiresAt = Math.min(demand.expiresAt, now + 900000, nextKstDay(now));
  const apps = config.apps.map((app) => {
    const asked = demand.apps.find((d) => d.appId === app.appId),
      account = accounts.find((a) => a.accountId === app.accountId);
    if (!account) throw Error("Missing configured account.");
    const allowance = account.shares.find((s) => s.appId === app.appId),
      snapshot = snapshots.find((s) => s.appId === app.appId);
    if (!allowance) throw Error("Missing app allowance.");
    const current =
      !!snapshot &&
      snapshot.appRevision === app.revision &&
      snapshot.generatedAt <= now;
    const candidates: Candidate[] = app.subjects
      .filter((s) => s.enabled)
      .map((subject) => {
        const offered = current
          ? snapshot.entries.find(
              (e) =>
                e.subjectId === subject.subjectId &&
                e.ruleRevision === subject.revision &&
                e.status === "ready",
            )?.offer
          : null;
        const offer = offered && offered.checkedAt <= now ? offered : null,
          cost = estimateRefreshCost(subject, now);
        const reach =
          asked?.subjects.find((s) => s.subjectId === subject.subjectId)
            ?.estimatedReach ?? 0;
        return {
          subject,
          reach,
          expiresAt: offer?.expiresAt ?? null,
          urgent:
            reach > 0 &&
            (!offer || offer.expiresAt <= now + demand.policy.urgentWithinMs),
          overdue: !offer || now - offer.checkedAt >= demand.policy.maxWaitMs,
          manual: cost.products === 0,
          tie: digest([
            demand.seed,
            Math.floor(now / 300000),
            app.appId,
            subject.subjectId,
          ]),
        };
      });
    const compare = (a: Candidate, b: Candidate) =>
      Number(b.urgent) - Number(a.urgent) ||
      Number(b.overdue) - Number(a.overdue) ||
      b.reach - a.reach ||
      (a.expiresAt ?? 0) - (b.expiresAt ?? 0) ||
      (a.tie < b.tie ? -1 : a.tie > b.tie ? 1 : 0);
    const wanted = candidates.filter((c) => c.reach > 0).sort(compare),
      exploration = candidates
        .filter((c) => c.reach === 0)
        .sort(
          (a, b) =>
            Number(b.overdue) - Number(a.overdue) ||
            (a.tie < b.tie ? -1 : a.tie > b.tie ? 1 : 0),
        );
    const selected: Candidate[] = [],
      reasons = new Map<string, string>();
    let usedProducts = 0,
      usedLinks = 0;
    const pick = (pool: Candidate[], limit: number, reason: string) => {
      let taken = 0;
      for (const c of pool) {
        if (
          taken >= limit ||
          selected.length >= demand.policy.maxSubjectsPerApp
        )
          break;
        if (reasons.has(c.subject.subjectId)) continue;
        const cost = estimateRefreshCost(c.subject, now);
        if (
          (account.blockedUntil > now && !c.manual) ||
          usedProducts + cost.products > allowance.productAllowance ||
          usedLinks + cost.links > allowance.linkAllowance
        )
          continue;
        selected.push(c);
        reasons.set(c.subject.subjectId, reason);
        usedProducts += cost.products;
        usedLinks += cost.links;
        taken++;
      }
    };
    // Reserve preview capacity and its conservative cost before demand can consume it.
    const exactSlots =
      demand.policy.maxSubjectsPerApp * demand.policy.explorationFraction;
    const fractional =
      Number.parseInt(
        digest([
          demand.seed,
          Math.floor(now / 300000),
          app.appId,
          "exploration",
        ]).slice(0, 13),
        16,
      ) /
      2 ** 52;
    const reserved = exploration.length
      ? Math.floor(exactSlots) + (fractional < exactSlots % 1 ? 1 : 0)
      : 0;
    pick(exploration, reserved, "exploration");
    pick(wanted, demand.policy.maxSubjectsPerApp - selected.length, "demand");
    if (demand.policy.explorationFraction > 0)
      pick(
        exploration,
        demand.policy.maxSubjectsPerApp - selected.length,
        "exploration",
      );
    selected.sort(
      (a, b) =>
        (reasons.get(a.subject.subjectId) === "exploration" ? 1 : 0) -
          (reasons.get(b.subject.subjectId) === "exploration" ? 1 : 0) ||
        compare(a, b),
    );
    const remainingProducts = allowance.productAllowance - usedProducts,
      remainingLinks = allowance.linkAllowance - usedLinks;
    return {
      appId: app.appId,
      appRevision: app.revision,
      contextId: asked?.contextId ?? null,
      measurementProfileId: asked?.measurementProfileId ?? null,
      snapshotCurrent: current,
      allowance,
      estimatedProducts: usedProducts,
      estimatedLinks: usedLinks,
      explorationReserved: reserved,
      explorationSelected: selected.filter(
        (c) => reasons.get(c.subject.subjectId) === "exploration",
      ).length,
      workset: worksetSchema.parse({
        schemaVersion: 1,
        appId: app.appId,
        appRevision: app.revision,
        expiresAt: Math.min(
          expiresAt,
          ...selected
            .filter((c) => c.manual)
            .map((c) => c.subject.manual?.reviewUntil ?? expiresAt),
        ),
        subjectIds: selected.map((c) => c.subject.subjectId),
      }),
      selected: selected.map((c) => ({
        subjectId: c.subject.subjectId,
        ruleRevision: c.subject.revision,
        estimatedReach: c.reach,
        offerExpiresAt: c.expiresAt,
        reason: c.urgent ? "urgent-demand" : reasons.get(c.subject.subjectId),
        overdue: c.overdue,
        estimatedCost: estimateRefreshCost(c.subject, now),
      })),
      deferred: candidates
        .filter((c) => !reasons.has(c.subject.subjectId))
        .sort(compare)
        .map((c) => {
          const cost = estimateRefreshCost(c.subject, now);
          return {
            subjectId: c.subject.subjectId,
            overdue: c.overdue,
            reason:
              account.blockedUntil > now && !c.manual
                ? "account-cooldown"
                : cost.products > remainingProducts ||
                    cost.links > remainingLinks
                  ? "account-share-budget"
                  : "capacity",
          };
        }),
    };
  });
  return {
    schemaVersion: 1,
    status: "preview-only",
    dispatchEnabled: false,
    budgetReservations: false,
    waitBoundEnforced: false,
    generatedAt: now,
    expiresAt: Math.min(expiresAt, ...apps.map((a) => a.workset.expiresAt)),
    policyId: demand.policy.policyId,
    policyVersion: demand.policy.version,
    maxWaitMs: demand.policy.maxWaitMs,
    accounts,
    apps,
  };
}
