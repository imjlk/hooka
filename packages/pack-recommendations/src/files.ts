import { mkdir, unlink, link } from "node:fs/promises";
import {
  openSync,
  fsyncSync,
  closeSync,
  existsSync,
  readFileSync,
  renameSync,
  statSync,
} from "node:fs";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { resultSchema, requestSchema } from "./contracts";
import { pointerSchema } from "./measurement";
import {
  digest,
  requestDigest as digestRequest,
  validateRecommendations,
} from "./engine";

export async function readArtifact(
  path: string,
  limit: number,
): Promise<unknown> {
  const file = Bun.file(path);
  if (!(await file.exists()) || file.size > limit)
    throw new Error("Missing or oversized recommendation artifact.");
  const text = await file.text();
  if (Buffer.byteLength(text) > limit)
    throw new Error("Recommendation artifact changed size while reading.");
  return JSON.parse(text);
}
function syncFile(path: string) {
  const fd = openSync(path, "r");
  try {
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
}
/** Complete immutable decision first, then a small atomic app-scoped pointer. */
export async function publishDecision(
  root: string,
  resultInput: unknown,
  request: unknown,
  now: number,
  commit: (action: () => void) => void,
) {
  const result = resultSchema.parse(resultInput);
  if (!validateRecommendations(result, request, now))
    throw new Error("Cannot publish invalid or expired decision.");
  const directory = join(root, result.appId, "requests", result.requestId),
    decisions = join(directory, "decisions");
  await mkdir(decisions, { recursive: true, mode: 0o700 });
  const destination = join(decisions, `${result.decisionId}.json`);
  const temp = join(decisions, `.${randomUUID()}.tmp`);
  await Bun.write(temp, `${JSON.stringify(result)}\n`, { mode: 0o600 });
  try {
    syncFile(temp);
    try {
      await link(temp, destination);
    } catch (error) {
      if (
        !(
          error &&
          typeof error === "object" &&
          "code" in error &&
          error.code === "EEXIST"
        )
      )
        throw error;
      if (
        digest(await readArtifact(destination, 2 * 1024 * 1024)) !==
        digest(result)
      )
        throw new Error("Conflicting immutable decision file.");
    }
    syncFile(decisions);
  } finally {
    await unlink(temp);
  }
  const pointer = pointerSchema.parse({
    schemaVersion: 1,
    appId: result.appId,
    requestId: result.requestId,
    decisionId: result.decisionId,
    modelGenerationId: result.modelGenerationId,
    inputDigest: result.inputDigest,
    generatedAt: result.generatedAt,
    expiresAt: result.expiresAt,
    file: `decisions/${result.decisionId}.json`,
  });
  const pointerTemp = join(directory, `.${randomUUID()}.tmp`);
  try {
    await Bun.write(pointerTemp, `${JSON.stringify(pointer)}\n`, {
      mode: 0o600,
    });
    syncFile(pointerTemp);
    // This small read/check/rename is synchronous while the dedicated DB holds
    // its writer lock. Concurrent CLI publishers cannot regress the pointer.
    commit(() => {
      const path = join(directory, "recommendations.json");
      if (existsSync(path)) {
        if (statSync(path).size > 4096)
          throw new Error("Oversized existing publication pointer.");
        const previous = pointerSchema.parse(
          JSON.parse(readFileSync(path, "utf8")),
        );
        if (
          previous.appId !== result.appId ||
          previous.requestId !== result.requestId ||
          typeof previous.generatedAt !== "number" ||
          previous.generatedAt > result.generatedAt ||
          (previous.generatedAt === result.generatedAt &&
            previous.decisionId !== result.decisionId)
        )
          throw new Error("Conflicting or newer publication pointer.");
      }
      renameSync(pointerTemp, path);
      syncFile(directory);
    });
  } finally {
    if (await Bun.file(pointerTemp).exists()) await unlink(pointerTemp);
  }
  return pointer;
}

export async function readPublishedDecision(
  root: string,
  requestInput: unknown,
  now = Date.now(),
) {
  try {
    const request = requestSchema.parse(requestInput);
    const directory = join(root, request.appId, "requests", request.requestId);
    const pointer = pointerSchema.parse(
      await readArtifact(join(directory, "recommendations.json"), 4096),
    );
    if (
      pointer.appId !== request.appId ||
      pointer.requestId !== request.requestId ||
      pointer.inputDigest !== digestRequest(request)
    )
      return null;
    const result = validateRecommendations(
      await readArtifact(join(directory, pointer.file), 2 * 1024 * 1024),
      request,
      now,
    );
    if (
      !result ||
      result.decisionId !== pointer.decisionId ||
      result.modelGenerationId !== pointer.modelGenerationId ||
      result.generatedAt !== pointer.generatedAt ||
      result.expiresAt !== pointer.expiresAt
    )
      return null;
    return result;
  } catch {
    return null;
  }
}
