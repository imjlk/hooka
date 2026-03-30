import { createAdminUiDevConfig } from "@hooka/config";
import index from "./index.html";

const config = createAdminUiDevConfig();

function serveIndex(): Response {
  // Bun HTML imports are response-like at runtime, but currently need a narrow cast here.
  return index as unknown as Response;
}

const server = Bun.serve({
  port: config.uiPort,
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
      const upstream = new URL(
        `${url.pathname}${url.search}`,
        config.apiOrigin,
      );
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
      apiOrigin: config.apiOrigin,
    },
    null,
    2,
  ),
);
