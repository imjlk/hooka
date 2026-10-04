// Test-only preload, mounted solely by the isolated E2E harness. Production
// provider URLs/allowlists stay fixed and have no configurable mock endpoint.
const originalFetch = globalThis.fetch;
globalThis.fetch = ((input: string | URL | Request, init?: RequestInit) => {
  const url = new URL(input instanceof Request ? input.url : String(input));
  if (!["oauth2.cert.toss.im", "sharelink.toss.im"].includes(url.hostname))
    throw new Error("Unexpected outbound request in Sharelink E2E.");
  return originalFetch(
    `http://mock:8080/${url.hostname}${url.pathname}${url.search}`,
    init,
  );
}) as typeof fetch;
