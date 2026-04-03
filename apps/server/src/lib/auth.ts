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
  input: { allowQueryToken?: boolean } = {},
): boolean {
  if (!expectedToken) {
    return false;
  }

  const bearerToken = readBearerToken(request);
  if (bearerToken === expectedToken) {
    return true;
  }

  if (!input.allowQueryToken) {
    return false;
  }

  const url = new URL(request.url);
  return url.searchParams.get("token") === expectedToken;
}

export function isPublicServerRoute(method: string, pathname: string): boolean {
  if (pathname === "/api/health" || pathname === "/api/ready") {
    return true;
  }

  return (
    method.toUpperCase() === "POST" && pathname.startsWith("/api/webhooks/")
  );
}
