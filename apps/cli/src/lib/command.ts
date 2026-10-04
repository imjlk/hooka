import { type Args, type Command, define } from "gunshi";
import type { z } from "zod";

interface OptionMetadata {
  description: string;
  short?: string;
  argumentKind?: "flag";
}

export interface CliOption<T extends z.ZodType = z.ZodType> {
  schema: T;
  metadata: OptionMetadata;
}

type NamedCommand = Command & { name: string };

type Options = Record<string, CliOption>;
type Flags<T extends Options> = { [K in keyof T]: z.output<T[K]["schema"]> };

/** Keep task Zod schemas authoritative while Gunshi parses and routes commands. */
export function option<T extends z.ZodType>(
  schema: T,
  metadata: OptionMetadata,
): CliOption<T> {
  return { schema, metadata };
}

/** Build a Gunshi command with Zod-validated flags and Bun's shell helper. */
export function defineCommand<T extends Options = Record<never, never>>(input: {
  name: string;
  description: string;
  options?: T;
  handler: (context: {
    flags: Flags<T>;
    positional: string[];
    shell: typeof Bun.$;
  }) => void | Promise<void>;
}): NamedCommand {
  const options: Options = input.options ?? {};
  const args: Args = Object.fromEntries(
    Object.entries(options).map(([name, { schema, metadata }]) => {
      const fallback = schema.safeParse(undefined);
      return [
        name,
        {
          type: metadata.argumentKind === "flag" ? "boolean" : "string",
          description: metadata.description,
          short: metadata.short,
          required: !fallback.success,
          // Defaults are validated again alongside explicit values below.
          ...(fallback.success &&
          (typeof fallback.data === "string" ||
            typeof fallback.data === "number" ||
            typeof fallback.data === "boolean")
            ? { default: fallback.data }
            : {}),
        },
      ];
    }),
  );

  return define({
    name: input.name,
    description: input.description,
    args,
    run: async (ctx) => {
      const values: Record<string, unknown> = { ...ctx.values };
      // Gunshi treats every boolean option token as true, including =false.
      // Read only parsed option tokens of this command (not payload strings or
      // arguments after --), preserving explicit false and last-option-wins.
      for (const [index, token] of ctx.tokens.entries()) {
        if (token.kind === "option-terminator") break;
        if (token.kind !== "option") continue;
        const entry = Object.entries(options).find(
          ([name, { metadata }]) =>
            token.rawName === `--${name}` ||
            (metadata.short && token.rawName === `-${metadata.short}`),
        );
        if (!entry) continue;
        // Short inline values are emitted as a separate token at the same index.
        const next = ctx.tokens[index + 1];
        const valueToken =
          next?.index === token.index && !next.rawName && next.inlineValue
            ? next
            : token;
        if (entry[1].metadata.argumentKind !== "flag") {
          // Gunshi substitutes the default for an explicit empty string. Let
          // Zod validate the user's actual inline value, including "".
          values[entry[0]] = valueToken.inlineValue
            ? valueToken.value
            : ctx.values[entry[0]];
          continue;
        }
        if (
          valueToken.inlineValue &&
          valueToken.value !== "true" &&
          valueToken.value !== "false"
        ) {
          throw new Error(`${token.rawName} must be true or false.`);
        }
        values[entry[0]] = valueToken.inlineValue
          ? valueToken.value === "true"
          : true;
      }
      const flags = Object.fromEntries(
        Object.entries(options).map(([name, { schema }]) => {
          const result = schema.safeParse(values[name]);
          if (!result.success) {
            throw new Error(
              `Invalid --${name}: ${result.error.issues.map((issue) => issue.message).join("; ")}`,
            );
          }
          return [name, result.data];
        }),
      ) as Flags<T>;
      await input.handler({
        flags,
        positional: [
          ...ctx.positionals.slice(ctx.commandPath.length),
          ...ctx.rest,
        ],
        shell: Bun.$,
      });
    },
  });
}

/** Native nested commands provide help and routing at every group level. */
export function defineGroup(input: {
  name: string;
  description: string;
  commands: NamedCommand[];
}): NamedCommand {
  return define({
    name: input.name,
    description: input.description,
    run: async (ctx) => {
      const usage = await ctx.env.renderUsage?.(ctx);
      if (usage) ctx.log(usage);
      return usage;
    },
    subCommands: Object.fromEntries(
      input.commands.map((command) => [command.name, command]),
    ),
  });
}
