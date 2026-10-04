import { afterEach, expect, mock, spyOn, test } from "bun:test";
import { failure } from "./errors";
import { SharelinkProvider } from "./provider";
import type { SharelinkStore } from "./store";
import {
  success,
  temporarySetup,
  testAccount,
  testProduct,
  testStore,
} from "./fixtures";

const originalFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = originalFetch;
  mock.restore();
});

async function withProvider(
  action: (provider: SharelinkProvider, store: SharelinkStore) => Promise<void>,
  guardOverride?: () => void,
) {
  const setup = await temporarySetup();
  const store = await testStore(setup.env.HOOKA_SHARELINK_DB_PATH);
  spyOn(store, "pace").mockImplementation(async (_id, guard) => guard());
  try {
    await store.withAccount(testAccount.accountId, async (guard) => {
      const provider = new SharelinkProvider(
        testAccount,
        "test-access",
        "test-secret",
        store,
        guardOverride ?? guard,
      );
      await action(provider, store);
    });
  } finally {
    store.close();
    await setup.cleanup();
  }
}

function fetchResponses(responses: Response[]) {
  const transport = mock(async () => {
    const next = responses.shift();
    if (!next) throw new Error("Unexpected fetch");
    return next;
  });
  globalThis.fetch = transport as unknown as typeof fetch;
  return transport;
}
const token = () =>
  Response.json({ access_token: "mock-token", expires_in: 3600 });

test("body-read lease loss preserves its code and retryability", async () => {
  let readFinished = false;
  const response = token();
  const body = response.body;
  if (!body) throw new Error("Missing response body");
  let readCount = 0;
  spyOn(body, "getReader").mockReturnValue({
    read: async () => {
      if (readCount++ === 0)
        return { done: false, value: new TextEncoder().encode("{}") };
      readFinished = true;
      return { done: true, value: undefined };
    },
  } as ReadableStreamDefaultReader<Uint8Array>);
  fetchResponses([response]);
  await withProvider(
    async (provider) => {
      await expect(provider.categories()).rejects.toMatchObject({
        code: "sharelink_lease_lost",
        retryable: true,
      });
    },
    () => {
      if (readFinished) throw failure("lease_lost", true);
    },
  );
});

test("oversized body retains response_too_large and malformed JSON remains terminal", async () => {
  fetchResponses([new Response(new Uint8Array(1048577))]);
  await withProvider(async (provider) => {
    await expect(provider.categories()).rejects.toMatchObject({
      code: "sharelink_response_too_large",
      retryable: false,
    });
  });
  fetchResponses([new Response("not-json")]);
  await withProvider(async (provider) => {
    await expect(provider.categories()).rejects.toMatchObject({
      code: "sharelink_invalid_response",
      retryable: false,
    });
  });
});

test("interrupted response streams are retryable transport failures", async () => {
  fetchResponses([
    new Response(
      new ReadableStream({
        start(controller) {
          controller.error(new Error("secret-upstream-text"));
        },
      }),
    ),
  ]);
  await withProvider(async (provider) => {
    await expect(provider.categories()).rejects.toMatchObject({
      code: "sharelink_transport",
      retryable: true,
      message: "Toss Sharelink: transport.",
    });
  });
});

test("HTTP 200 access denial stops requests and does not reveal upstream error text", async () => {
  const transport = fetchResponses([
    token(),
    Response.json({
      resultType: "FAIL",
      error: {
        errorCode: "SHARELINK_OPENAPI_ACCESS_DENIED",
        reason: "private-text",
      },
    }),
  ]);
  await withProvider(async (provider) => {
    await expect(provider.issue("123", "channel")).rejects.toMatchObject({
      code: "sharelink_access_denied",
      retryable: false,
    });
  });
  expect(transport).toHaveBeenCalledTimes(2);
});

test("product and issued-link caches are reused across provider instances", async () => {
  const transport = fetchResponses([
    token(),
    success({ items: [testProduct()] }),
    success({
      tacaItemId: 123,
      publisherId: testAccount.publisherId,
      shortUrl: "https://toss.im/_m/example",
    }),
  ]);
  await withProvider(async (provider, store) => {
    expect((await provider.list("10"))[0]?.id).toBe("123");
    expect(await provider.issue("123", "channel")).toBe(
      "https://toss.im/_m/example",
    );
    const second = new SharelinkProvider(
      testAccount,
      "test-access",
      "test-secret",
      store,
      () => {},
    );
    expect((await second.list("10"))[0]?.id).toBe("123");
    expect(await second.issue("123", "channel")).toBe(
      "https://toss.im/_m/example",
    );
  });
  expect(transport).toHaveBeenCalledTimes(3);
});

test("link host and publisher must match before caching", async () => {
  fetchResponses([
    token(),
    success({
      tacaItemId: 123,
      publisherId: testAccount.publisherId,
      shortUrl: "https://toss.im.attacker.invalid/product",
    }),
  ]);
  await withProvider(async (provider) => {
    await expect(provider.issue("123", "channel")).rejects.toMatchObject({
      code: "sharelink_invalid_link",
    });
  });
});

test.each([
  ["today-deals", "/openapi/products/today-deals"],
  ["overall-best", "/openapi/products/best-selling"],
] as const)(
  "%s is an explicit source with cached provider results",
  async (source, path) => {
    const transport = fetchResponses([
      token(),
      success({ items: [testProduct()] }),
    ]);
    await withProvider(async (provider) => {
      expect((await provider.list("10", source))[0]?.id).toBe("123");
      await provider.list("10", source);
    });
    expect(transport).toHaveBeenCalledTimes(2);
    // The transport assertion below is exercised through a separate route-aware fetch.
    const urls: string[] = [];
    globalThis.fetch = mock(async (url: string | URL | Request) => {
      urls.push(String(url));
      return String(url).includes("oauth2") ? token() : success({ items: [] });
    }) as unknown as typeof fetch;
    await withProvider(async (provider) => {
      expect(await provider.list("10", source)).toEqual([]);
    });
    expect(new URL(urls[1] ?? "https://invalid.local").pathname).toBe(path);
  },
);

test("near-expiry details are renewed before the scheduler window", async () => {
  const transport = fetchResponses([
    token(),
    success({ items: [testProduct()] }),
  ]);
  await withProvider(async (provider, store) => {
    store.put(
      testAccount.accountId,
      "detail:123",
      {
        product: {
          id: "123",
          title: "베개",
          categoryIds: ["10"],
          soldOut: false,
        },
        checkedAt: Date.now() - 600000,
        expiresAt: Date.now() + 240000,
      },
      Date.now() + 240000,
    );
    const detail = await provider.detail("123");
    expect(detail?.expiresAt).toBeGreaterThan(Date.now() + 14 * 60000);
  });
  expect(transport).toHaveBeenCalledTimes(2);
});

test("an insufficient local budget persists a daily scheduler pause even with a nonzero remainder", async () => {
  const transport = fetchResponses([token()]);
  await withProvider(async (provider, store) => {
    store.reserve({ ...testAccount, productBudget: 20 }, 1, 0);
    await expect(provider.list("10")).rejects.toMatchObject({
      code: "sharelink_local_daily_budget",
    });
    const state = store.db
      .query<{ blocked_until: number }, []>(
        "SELECT blocked_until FROM sharelink_accounts",
      )
      .get();
    expect(state?.blocked_until).toBeGreaterThan(Date.now());
  });
  expect(transport).toHaveBeenCalledTimes(1);
});
