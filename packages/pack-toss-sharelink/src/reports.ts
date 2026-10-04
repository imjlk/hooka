import { z } from "zod";
import type {
  App,
  PerformanceInput,
  SettlementInput,
  SharelinkReport,
} from "./contracts";
import {
  performanceItem,
  performanceSummary,
  reportSchema,
  settlementAmounts,
  settlementItem,
} from "./contracts";
import { failure } from "./errors";
import type { SharelinkProvider } from "./provider";

/** Summary is for the entire range, never summed once per page. */
export async function collectReport(
  provider: SharelinkProvider,
  app: App,
  input: PerformanceInput | SettlementInput,
  kind: "performance" | "settlement",
): Promise<SharelinkReport> {
  let cursor: string | undefined;
  let summary: unknown;
  const items: unknown[] = [];
  const cursors = new Set<string>();
  const seen = new Set<string>();
  const query = { ...input, subTagId: app.subTagId };
  for (let page = 0; page < 50; page++) {
    const raw = await provider.reportPage(kind, { ...query, cursor });
    const parsed = z
      .object({
        subTagId: z.string(),
        items: z.array(z.unknown()).max(100),
        summary: z.unknown(),
        hasNext: z.boolean(),
        nextCursor: z.string().min(1).max(4096).nullable(),
      })
      .safeParse(raw);
    if (!parsed.success || parsed.data.subTagId !== app.subTagId)
      throw failure("invalid_report");
    if (
      (kind === "performance" &&
        (raw["fromDate"] !== (input as PerformanceInput).fromDate ||
          raw["toDate"] !== (input as PerformanceInput).toDate)) ||
      (kind === "settlement" &&
        raw["settlementMonth"] !== (input as SettlementInput).settlementMonth)
    )
      throw failure("invalid_report_period");
    const totals = (
      kind === "performance" ? performanceSummary : settlementAmounts
    ).safeParse(parsed.data.summary);
    if (!totals.success) throw failure("invalid_report_summary");
    if (page === 0) summary = totals.data;
    for (const value of parsed.data.items) {
      const item = (
        kind === "performance" ? performanceItem : settlementItem
      ).safeParse(value);
      if (
        !item.success ||
        (input.attribution && item.data.attribution !== input.attribution)
      )
        throw failure("invalid_report_item");
      const key = `${item.data.productId}:${item.data.attribution}`;
      if (seen.has(key))
        throw failure("report_changed_during_pagination", true);
      seen.add(key);
      items.push(item.data);
    }
    if (!parsed.data.hasNext) {
      return reportSchema.parse({
        schemaVersion: 1,
        kind,
        appId: app.appId,
        collectedAt: Date.now(),
        ...(kind === "performance"
          ? {
              fromDate: (input as PerformanceInput).fromDate,
              toDate: (input as PerformanceInput).toDate,
            }
          : { settlementMonth: (input as SettlementInput).settlementMonth }),
        attribution: input.attribution ?? null,
        summary,
        items,
      });
    }
    const next = parsed.data.nextCursor;
    if (!next || cursors.has(next)) throw failure("invalid_report_cursor");
    cursors.add(next);
    cursor = next;
  }
  throw failure("report_page_limit");
}
