import { timingSafeEqual } from "node:crypto";

export function isMatchingSecret(
  received: string | null | undefined,
  expected: string | undefined,
): boolean {
  if (!received || !expected) {
    return false;
  }

  const receivedBuffer = Buffer.from(received, "utf8");
  const expectedBuffer = Buffer.from(expected, "utf8");

  if (receivedBuffer.length !== expectedBuffer.length) {
    return false;
  }

  return timingSafeEqual(receivedBuffer, expectedBuffer);
}

export function readBearerToken(request: Request): string | null {
  const header = request.headers.get("authorization")?.trim();

  if (!header?.toLowerCase().startsWith("bearer ")) {
    return null;
  }

  const token = header.slice("Bearer ".length).trim();
  return token.length > 0 ? token : null;
}

export function isAuthorizedAdminRequest(
  request: Request,
  expectedToken: string | undefined,
): boolean {
  if (!expectedToken) {
    return false;
  }

  return isMatchingSecret(readBearerToken(request), expectedToken);
}

export function isAuthorizedWebhookSecretRequest(
  request: Request,
  expectedSecret: string | undefined,
): boolean {
  return (
    isMatchingSecret(readBearerToken(request), expectedSecret) ||
    isMatchingSecret(
      request.headers.get("x-hooka-webhook-secret"),
      expectedSecret,
    )
  );
}

export function isPublicServerRoute(method: string, pathname: string): boolean {
  if (
    pathname === "/api/health" ||
    pathname === "/api/ready" ||
    pathname === "/api/openapi.json"
  ) {
    return true;
  }

  return (
    method.toUpperCase() === "POST" && pathname.startsWith("/api/webhooks/")
  );
}
