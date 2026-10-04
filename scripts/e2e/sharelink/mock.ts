const calls: Record<string, number> = {};
let active = 0;
let maxActive = 0;
let holdDetails = false;
let quota = false;
let release: (() => void) | undefined;
let held = false;
const ok = (success: unknown) =>
  Response.json({ resultType: "SUCCESS", success });
const product = (id: number) => ({
  tacaItemId: id,
  displayName: "편안한 베개",
  categoryIds: [id === 123 ? 10 : 20],
  isSoldOut: false,
});
Bun.serve({
  hostname: "0.0.0.0",
  port: 8080,
  async fetch(request) {
    const url = new URL(request.url);
    if (url.pathname === "/_state")
      return Response.json({ calls, active, maxActive, held });
    if (url.pathname === "/_control" && request.method === "POST") {
      const body = (await request.json()) as {
        holdDetails?: boolean;
        quota?: boolean;
      };
      if (body.holdDetails !== undefined) {
        holdDetails = body.holdDetails;
        if (!holdDetails) release?.();
      }
      if (body.quota !== undefined) quota = body.quota;
      return ok({});
    }
    calls[url.pathname] = (calls[url.pathname] ?? 0) + 1;
    active++;
    maxActive = Math.max(active, maxActive);
    try {
      await Bun.sleep(30);
      if (url.pathname === "/oauth2.cert.toss.im/token")
        return Response.json({ access_token: "e2e-token", expires_in: 3600 });
      if (quota)
        return Response.json({
          resultType: "FAIL",
          error: { errorCode: "SHARELINK_OPENAPI_QUOTA_EXCEEDED" },
        });
      const path = url.pathname.replace("/sharelink.toss.im", "");
      if (path === "/openapi/categories")
        return ok({
          categories: [
            { categoryId: 10, children: [] },
            { categoryId: 20, children: [] },
          ],
        });
      if (path.startsWith("/openapi/products/best-categories/"))
        return ok({ items: [product(path.endsWith("/10") ? 123 : 456)] });
      if (path === "/openapi/products/detail") {
        if (holdDetails) {
          held = true;
          await new Promise<void>((resolve) => {
            release = resolve;
          });
          held = false;
        }
        return ok({
          items: [product(Number(url.searchParams.get("tacaItemIds")))],
        });
      }
      if (path === "/openapi/links") {
        const body = (await request.json()) as {
          tacaItemId: number;
          publisherId: string;
          subTagId: string;
        };
        return ok({
          ...body,
          shortUrl: `https://toss.im/_m/e2e-${body.subTagId}-${body.tacaItemId}`,
        });
      }
      return new Response("Unexpected mock route", { status: 404 });
    } finally {
      active--;
    }
  },
});
