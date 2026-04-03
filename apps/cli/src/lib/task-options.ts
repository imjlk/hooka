import { option, type CLIOption } from "@bunli/core";
import type { AnyTask } from "@hooka/task-sdk";
import { z } from "zod";
import { booleanFlagSchema } from "./shared";

const payloadJsonSchema = z.string().optional();
const payloadFileSchema = z.string().optional();
const dryRunSchema = booleanFlagSchema;

export interface TaskOptionConfig {
  includeDryRun?: boolean;
}

export function taskToBunliOptions(
  task: AnyTask,
  config: TaskOptionConfig = {},
): Record<string, CLIOption<any>> {
  const includeDryRun = config.includeDryRun ?? true;

  if (!(task.input instanceof z.ZodObject)) {
    return {
      "payload-json": option(payloadJsonSchema, {
        description: "Inline JSON payload for non-scalar task inputs.",
      }),
      "payload-file": option(payloadFileSchema, {
        description: "Path to a JSON file for non-scalar task inputs.",
      }),
      ...(includeDryRun
        ? {
            "dry-run": option(dryRunSchema, {
              description: "Validate and plan the task without executing it.",
            }),
          }
        : {}),
    };
  }

  const shape = task.input.shape;
  const options = Object.fromEntries(
    Object.entries(shape).flatMap(([key, schema]) => {
      const cliSchema = toCliScalarSchema(schema);

      if (!cliSchema) {
        return [];
      }

      return [
        [
          toKebabCase(key),
          option(cliSchema, {
            description: `${task.id} input: ${key}`,
          }),
        ],
      ];
    }),
  );

  return {
    ...options,
    "payload-json": option(payloadJsonSchema, {
      description: "Inline JSON payload fallback for nested input values.",
    }),
    "payload-file": option(payloadFileSchema, {
      description: "Path to a JSON payload file for nested input values.",
    }),
    ...(includeDryRun
      ? {
          "dry-run": option(dryRunSchema, {
            description: "Validate and plan the task without executing it.",
          }),
        }
      : {}),
  };
}

export async function buildTaskInputFromFlags(
  task: AnyTask,
  flags: Record<string, unknown>,
): Promise<Record<string, unknown>> {
  const payload = await loadPayload(flags);

  if (!(task.input instanceof z.ZodObject)) {
    return payload;
  }

  const scalarFlags = Object.fromEntries(
    Object.keys(task.input.shape).flatMap((key) => {
      const flagKey = toKebabCase(key);
      const value = flags[flagKey];

      return value === undefined ? [] : [[key, value]];
    }),
  );

  return { ...payload, ...scalarFlags };
}

function toCliScalarSchema(schema: z.ZodTypeAny): z.ZodTypeAny | null {
  const details = unwrapSchema(schema);
  let cliSchema: z.ZodTypeAny | null = null;

  if (details.base instanceof z.ZodString) {
    cliSchema = z.string();
  } else if (details.base instanceof z.ZodEnum) {
    cliSchema = details.base;
  } else if (details.base instanceof z.ZodNumber) {
    cliSchema = z.coerce.number();
  } else if (details.base instanceof z.ZodBoolean) {
    cliSchema = z.coerce.boolean();
  } else if (details.base instanceof z.ZodLiteral) {
    cliSchema = z.literal(details.base.value);
  }

  if (!cliSchema) {
    return null;
  }

  if (details.defaultValue !== undefined) {
    cliSchema = cliSchema.default(details.defaultValue);
  } else if (details.optional) {
    cliSchema = cliSchema.optional();
  }

  return cliSchema;
}

function unwrapSchema(schema: z.ZodTypeAny): {
  base: z.ZodTypeAny;
  optional: boolean;
  defaultValue: unknown;
} {
  let current: z.ZodTypeAny = schema;
  let optional = false;
  let defaultValue: unknown;

  while (true) {
    if (current instanceof z.ZodOptional || current instanceof z.ZodNullable) {
      optional = true;
      current = (current as z.ZodOptional<z.ZodTypeAny>).unwrap();
      continue;
    }

    if (current instanceof z.ZodDefault) {
      optional = true;
      const defaultGetter = (
        current as z.ZodDefault<z.ZodTypeAny> & {
          _def: {
            defaultValue: unknown;
            innerType: z.ZodTypeAny;
          };
        }
      )._def;
      defaultValue =
        typeof defaultGetter.defaultValue === "function"
          ? (defaultGetter.defaultValue as () => unknown)()
          : defaultGetter.defaultValue;
      current = defaultGetter.innerType;
      continue;
    }

    break;
  }

  return {
    base: current,
    optional,
    defaultValue,
  };
}

async function loadPayload(
  flags: Record<string, unknown>,
): Promise<Record<string, unknown>> {
  if (
    typeof flags["payload-file"] === "string" &&
    flags["payload-file"].length > 0
  ) {
    const file = Bun.file(flags["payload-file"]);
    const raw = await file.text();
    return JSON.parse(raw) as Record<string, unknown>;
  }

  if (
    typeof flags["payload-json"] === "string" &&
    flags["payload-json"].length > 0
  ) {
    return JSON.parse(flags["payload-json"]) as Record<string, unknown>;
  }

  return {};
}

function toKebabCase(value: string): string {
  return value.replace(/[A-Z]/g, (character) => `-${character.toLowerCase()}`);
}
