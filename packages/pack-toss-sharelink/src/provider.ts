import { z } from "zod";
import { isTaskExecutionError } from "@hooka/task-sdk";
import type { Account } from "./contracts";
import { isIssuedLink, providerIdSchema } from "./contracts";
import { failure } from "./errors";
import { digest, nextKstDay, type SharelinkStore } from "./store";

const BASE = "https://sharelink.toss.im/openapi";
const TOKEN = "https://oauth2.cert.toss.im/token";
const positiveId = z
  .number()
  .int()
  .positive()
  .refine(Number.isSafeInteger)
  .transform(String)
  .pipe(providerIdSchema);
const productSchema = z.object({
  tacaItemId: positiveId,
  displayName: z
    .string()
    .trim()
    .min(1)
    .max(180)
    .regex(/^[^\p{Cc}]*$/u),
  categoryIds: z.array(positiveId).max(32),
  isSoldOut: z.boolean(),
  endAt: z.string().datetime({ offset: true }).nullish(),
});
export interface Product {
  id: string;
  title: string;
  categoryIds: string[];
  soldOut: boolean;
  endAt?: number;
}
export interface Category {
  id: string;
  children: Category[];
}
export interface FreshProduct {
  product: Product;
  checkedAt: number;
  expiresAt: number;
}
export interface CatalogPage {
  products: Product[];
  nextCursor: string | null;
}

/** All calls use fixed official endpoints; no target URL comes from a task payload. */
export class SharelinkProvider {
  private readonly deadline = Date.now() + 120000;
  private readonly tokenKey: string;
  constructor(
    private readonly account: Account,
    private readonly accessKey: string,
    private readonly secretKey: string,
    private readonly store: SharelinkStore,
    private readonly guard: () => void,
  ) {
    this.tokenKey = `oauth:${digest([accessKey, secretKey])}`;
  }

  /** Enforce partner pacing and bounded transport while preserving retry classifications. */
  private async request(
    url: string,
    init: RequestInit,
    products = 0,
    links = 0,
  ): Promise<Record<string, unknown>> {
    if (Date.now() >= this.deadline) throw failure("batch_time_limit", true);
    await this.store.pace(this.account.accountId, this.guard);
    try {
      this.store.reserve(this.account, products, links);
    } catch (error) {
      // A nonzero remainder may still be too small for the next category page.
      // Persist the pause so scheduler ticks do not retry the same failing batch.
      if (
        isTaskExecutionError(error) &&
        error.code === "sharelink_local_daily_budget"
      )
        this.store.block(this.account.accountId, nextKstDay());
      throw error;
    }
    let response: Response;
    try {
      response = await fetch(url, {
        ...init,
        redirect: "error",
        signal: AbortSignal.timeout(5000),
      });
    } catch {
      this.guard();
      this.store.block(this.account.accountId, Date.now() + 60000);
      throw failure("transport", true);
    }
    this.guard();
    if (!response.ok) {
      await response.body?.cancel();
      const retry = response.headers.get("retry-after");
      const delay = retry
        ? Number.isFinite(Number(retry))
          ? Number(retry) * 1000
          : Date.parse(retry) - Date.now()
        : 60000;
      this.store.block(
        this.account.accountId,
        Date.now() +
          Math.min(
            86400000,
            Math.max(60000, Number.isFinite(delay) ? delay : 60000),
          ),
      );
      if (response.status === 401)
        this.store.put(this.account.accountId, this.tokenKey, null, 0);
      throw failure(
        `http_${response.status}`,
        response.status === 408 ||
          response.status === 429 ||
          response.status >= 500,
      );
    }
    let bodyComplete = false;
    try {
      const reader = response.body?.getReader();
      if (!reader) throw failure("invalid_response");
      const chunks: Uint8Array[] = [];
      let size = 0;
      while (true) {
        const { value, done } = await reader.read();
        if (done) break;
        size += value.byteLength;
        if (size > 1048576) {
          await reader.cancel();
          throw failure("response_too_large");
        }
        chunks.push(value);
      }
      bodyComplete = true;
      this.guard();
      return z
        .record(z.string(), z.unknown())
        .parse(JSON.parse(Buffer.concat(chunks).toString("utf8")));
    } catch (error) {
      if (isTaskExecutionError(error)) throw error;
      if (!bodyComplete) {
        this.guard();
        this.store.block(this.account.accountId, Date.now() + 60000);
        throw failure("transport", true);
      }
      throw failure("invalid_response");
    }
  }

  /** Cache tokens by credential fingerprint so secret rotation cannot reuse an old token. */
  private async token(): Promise<string> {
    const cached = this.store.get<string>(
      this.account.accountId,
      this.tokenKey,
    );
    if (cached) return cached.value;
    const raw = await this.request(TOKEN, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        grant_type: "client_credentials",
        client_id: this.accessKey,
        client_secret: this.secretKey,
        scope: "sharelink:read sharelink:write",
      }).toString(),
    });
    const parsed = z
      .object({
        access_token: z.string().min(1).max(16384),
        expires_in: z.number().finite().min(61).max(31536000),
      })
      .safeParse(raw);
    if (!parsed.success) throw failure("invalid_token");
    this.store.put(
      this.account.accountId,
      this.tokenKey,
      parsed.data.access_token,
      Date.now() + (parsed.data.expires_in - 60) * 1000,
    );
    return parsed.data.access_token;
  }

  /** Treat provider-level failures inside HTTP 200 as failures and persist global cooldowns. */
  private async api(
    path: string,
    options: { body?: unknown; products?: number; links?: number } = {},
  ): Promise<Record<string, unknown>> {
    const bearer = await this.token();
    const raw = await this.request(
      `${BASE}${path}`,
      {
        method: options.body ? "POST" : "GET",
        headers: {
          authorization: `Bearer ${bearer}`,
          "content-type": "application/json",
        },
        ...(options.body ? { body: JSON.stringify(options.body) } : {}),
      },
      options.products,
      options.links,
    );
    if (raw["resultType"] !== "SUCCESS") {
      const error = z
        .object({ errorCode: z.string().optional() })
        .passthrough()
        .safeParse(raw["error"]);
      const code = error.success ? error.data.errorCode : undefined;
      if (
        path === "/links" &&
        raw["resultType"] === "FAIL" &&
        error.success &&
        !code
      )
        throw failure("item_unavailable");
      if (code === "SHARELINK_OPENAPI_QUOTA_EXCEEDED") {
        this.store.block(this.account.accountId, nextKstDay());
        throw failure("provider_daily_budget");
      }
      this.store.block(this.account.accountId, Date.now() + 60000);
      throw failure(
        code === "SHARELINK_OPENAPI_ACCESS_DENIED"
          ? "access_denied"
          : "provider_rejected",
      );
    }
    const parsed = z.record(z.string(), z.unknown()).safeParse(raw["success"]);
    if (!parsed.success) throw failure("invalid_response");
    return parsed.data;
  }

  /** Normalize a bounded category tree shared by every consumer using this account. */
  async categories(): Promise<Category[]> {
    const key = "categories";
    const cached = this.store.get<Category[]>(this.account.accountId, key);
    if (cached) return cached.value;
    const raw = await this.api("/categories");
    let count = 0;
    const seen = new Set<string>();
    const read = (input: unknown, depth = 0): Category[] => {
      if (!Array.isArray(input) || depth > 8)
        throw failure("invalid_categories");
      return input.map((item) => {
        if (++count > 1000) throw failure("invalid_categories");
        const parsed = z
          .object({
            categoryId: positiveId,
            children: z.array(z.unknown()).nullish(),
          })
          .safeParse(item);
        if (!parsed.success || seen.has(parsed.data.categoryId))
          throw failure("invalid_categories");
        seen.add(parsed.data.categoryId);
        return {
          id: parsed.data.categoryId,
          children: read(parsed.data.children ?? [], depth + 1),
        };
      });
    };
    const categories = read(raw["categories"]);
    this.store.put(
      this.account.accountId,
      key,
      categories,
      Date.now() + 86400000,
    );
    return categories;
  }

  /** Compatibility reader for the first page of the explicitly selected source. */
  async list(
    categoryId: string,
    source: "category-best" | "today-deals" | "overall-best" = "category-best",
  ): Promise<Product[]> {
    return (await this.listPage(categoryId, source)).products;
  }

  /** Every page reserves 30 units; cursors are opaque provider values, never target URLs. */
  async listPage(
    categoryId: string,
    source: "category-best" | "today-deals" | "overall-best" = "category-best",
    cursor?: string,
  ): Promise<CatalogPage> {
    if (
      cursor !== undefined &&
      (!cursor || cursor.length > 4096 || /\p{Cc}/u.test(cursor))
    )
      throw failure("invalid_catalog_cursor");
    const key = `catalog-page:${digest([source, source === "category-best" ? categoryId : null, cursor ?? null])}`;
    const cached = this.store.get<CatalogPage>(this.account.accountId, key);
    if (cached) return cached.value;
    const path =
      source === "category-best"
        ? `/products/best-categories/${categoryId}`
        : source === "today-deals"
          ? "/products/today-deals"
          : "/products/best-selling";
    const query = new URLSearchParams({ size: "30" });
    if (cursor) query.set("cursor", cursor);
    const raw = await this.api(`${path}?${query}`, { products: 30 });
    if (!Array.isArray(raw["items"]) || raw["items"].length > 30)
      throw failure("invalid_products");
    // Missing pagination metadata is treated as a terminal first page for v1 compatibility.
    if (raw["hasNext"] !== undefined && typeof raw["hasNext"] !== "boolean")
      throw failure("invalid_catalog_cursor");
    const nextCursor = raw["hasNext"] === true ? raw["nextCursor"] : null;
    if (
      nextCursor !== null &&
      (typeof nextCursor !== "string" ||
        !nextCursor ||
        nextCursor.length > 4096 ||
        /\p{Cc}/u.test(nextCursor) ||
        nextCursor === cursor)
    )
      throw failure("invalid_catalog_cursor");
    const products = raw["items"]
      .map(normalizeProduct)
      .filter((p): p is Product => p !== null);
    // Category best refreshes at 09:00 KST (00:00 UTC); expire at that boundary.
    this.store.put(
      this.account.accountId,
      key,
      { products, nextCursor },
      Math.min(
        source === "category-best"
          ? Math.floor(Date.now() / 86400000 + 1) * 86400000
          : Date.now() + (source === "today-deals" ? 15 * 60000 : 3600000),
        ...products.map((p) => p.endAt ?? Infinity),
      ),
    );
    return { products, nextCursor };
  }

  /** Recheck availability independently from the longer-lived category ranking cache. */
  async detail(productId: string): Promise<FreshProduct | null> {
    const key = `detail:${productId}`;
    const cached = this.store.get<FreshProduct | null>(
      this.account.accountId,
      key,
    );
    // Renew before the five-minute scheduler window so refresh does not republish nearly expired details.
    if (cached && cached.expiresAt > Date.now() + 5 * 60000)
      return cached.value;
    const raw = await this.api(`/products/detail?tacaItemIds=${productId}`, {
      products: 1,
    });
    if (!Array.isArray(raw["items"]) || raw["items"].length > 1)
      throw failure("invalid_products");
    const product = raw["items"].length
      ? normalizeProduct(raw["items"][0])
      : null;
    if (product && product.id !== productId) throw failure("invalid_products");
    const checkedAt = Date.now();
    const expiresAt = Math.min(
      checkedAt + 15 * 60000,
      product?.endAt ?? Infinity,
    );
    const value = product ? { product, checkedAt, expiresAt } : null;
    this.store.put(this.account.accountId, key, value, expiresAt);
    return value;
  }

  /** Register or restore the configured channel only when explicitly requested by an operator. */
  async ensureSubTag(subTagId: string): Promise<void> {
    const raw = await this.api("/sub-tags/create", {
      body: { subTags: [{ subTagId }] },
    });
    const parsed = z
      .object({
        results: z
          .array(
            z.object({
              subTagId: z.string(),
              status: z.enum(["CREATED", "ALREADY_EXISTS", "RESTORED"]),
            }),
          )
          .length(1),
      })
      .safeParse(raw);
    if (!parsed.success || parsed.data.results[0]?.subTagId !== subTagId)
      throw failure("subtag_registration_failed");
  }

  /** Read one app-scoped metrics page without consuming the product-return budget. */
  async reportPage(
    kind: "performance" | "settlement",
    query: {
      subTagId: string;
      cursor?: string;
      attribution?: string;
      fromDate?: string;
      toDate?: string;
      settlementMonth?: string;
    },
  ): Promise<Record<string, unknown>> {
    const parameters = new URLSearchParams({
      subTagId: query.subTagId,
      size: "100",
    });
    if (query.cursor) parameters.set("cursor", query.cursor);
    if (query.attribution) parameters.set("attribution", query.attribution);
    if (kind === "performance") {
      if (!query.fromDate || !query.toDate)
        throw failure("invalid_report_period");
      parameters.set("fromDate", query.fromDate);
      parameters.set("toDate", query.toDate);
    }
    if (kind === "settlement" && !query.settlementMonth)
      throw failure("invalid_report_period");
    return this.api(
      `${kind === "performance" ? "/performance" : `/settlements/${query.settlementMonth}`}?${parameters}`,
    );
  }

  /** Reuse provider-issued URLs only after validating product, publisher and exact destination host. */
  async issue(productId: string, subTagId: string): Promise<string> {
    const key = `link:${this.account.publisherId}:${subTagId}:${productId}`;
    const cached = this.store.get<string>(this.account.accountId, key);
    if (cached) return cached.value;
    const raw = await this.api("/links", {
      body: {
        tacaItemId: Number(productId),
        publisherId: this.account.publisherId,
        subTagId,
      },
      links: 1,
    });
    const url = [raw["shortUrl"], raw["originUrl"]].find(
      (u) => typeof u === "string" && isIssuedLink(u),
    );
    if (
      String(raw["tacaItemId"]) !== productId ||
      raw["publisherId"] !== this.account.publisherId ||
      typeof url !== "string"
    )
      throw failure("invalid_link");
    this.store.put(
      this.account.accountId,
      key,
      url,
      Date.now() + 30 * 86400000,
    );
    return url;
  }
}

/** Discard malformed provider products instead of guessing category or availability. */
function normalizeProduct(raw: unknown): Product | null {
  const parsed = productSchema.safeParse(raw);
  if (!parsed.success) return null;
  const data = parsed.data;
  return {
    id: data.tacaItemId,
    title: data.displayName,
    categoryIds: data.categoryIds,
    soldOut: data.isSoldOut,
    ...(data.endAt ? { endAt: Date.parse(data.endAt) } : {}),
  };
}
