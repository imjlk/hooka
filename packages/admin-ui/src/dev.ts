import index from "./index.html";

const port = Number(Bun.env.HOOKA_UI_PORT ?? 4310);
const apiOrigin = Bun.env.HOOKA_UI_API_ORIGIN ?? "http://127.0.0.1:3000";

function serveIndex(): Response {
  // Bun HTML imports are response-like at runtime, but currently need a narrow cast here.
  return index as unknown as Response;
}

const server = Bun.serve({
  port,
  routes: {
    "/": index,
    "/index.html": index,
  },
  development: {
    hmr: true,
    console: true,
  },
  async fetch(request) {
    const url = new URL(request.url);

    if (url.pathname.startsWith("/api/")) {
      const upstream = new URL(`${url.pathname}${url.search}`, apiOrigin);
      return fetch(upstream, {
        method: request.method,
        headers: request.headers,
        body:
          request.method === "GET" || request.method === "HEAD"
            ? undefined
            : request.body,
      });
    }

    return serveIndex();
  },
});

console.log(
  JSON.stringify(
    {
      service: "hooka-admin-ui-dev",
      port: server.port,
      apiOrigin,
    },
    null,
    2,
  ),
);
