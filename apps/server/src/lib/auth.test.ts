import { expect, test } from "bun:test";
import { isAuthorizedAdminRequest, readBearerToken } from "./auth";

test("readBearerToken returns the bearer token when present", () => {
  const request = new Request("http://hooka.local/api/runs", {
    headers: {
      authorization: "Bearer admin-token",
    },
  });

  expect(readBearerToken(request)).toBe("admin-token");
});

test("isAuthorizedAdminRequest accepts matching bearer tokens", () => {
  const request = new Request("http://hooka.local/api/runs", {
    headers: {
      authorization: "Bearer admin-token",
    },
  });

  expect(isAuthorizedAdminRequest(request, "admin-token")).toBe(true);
});

test("isAuthorizedAdminRequest rejects mismatched bearer tokens", () => {
  const request = new Request("http://hooka.local/api/runs", {
    headers: {
      authorization: "Bearer admin-token-x",
    },
  });

  expect(isAuthorizedAdminRequest(request, "admin-token")).toBe(false);
});

test("isAuthorizedAdminRequest ignores query tokens", () => {
  const request = new Request(
    "http://hooka.local/api/events/stream?token=stream-token",
  );

  expect(isAuthorizedAdminRequest(request, "stream-token")).toBe(false);
});
