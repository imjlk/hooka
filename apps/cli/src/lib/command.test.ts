import { expect, test } from "bun:test";
import { cli } from "gunshi";
import { z } from "zod";
import { defineCommand, defineGroup, option } from "./command";
import { booleanFlag } from "./shared";

const cliOptions = {
  name: "hooka",
  renderHeader: null,
  usageSilent: true,
  strict: true,
};

async function parse(args: string[]) {
  let result: unknown;
  const command = defineCommand({
    name: "probe",
    description: "CLI compatibility probe.",
    options: {
      yes: booleanFlag({ description: "Confirm.", short: "y" }),
      "no-bundle": option(z.boolean().optional(), {
        description: "Literal no- flag.",
        argumentKind: "flag",
      }),
      payload: option(z.string().optional(), { description: "Text payload." }),
      limit: option(z.coerce.number().int().positive().default(10), {
        description: "Limit.",
      }),
    },
    handler: (context) => {
      result = { flags: context.flags, positional: context.positional };
    },
  });
  const root = defineGroup({
    name: "hooka",
    description: "Hooka",
    commands: [
      defineGroup({ name: "group", description: "Group", commands: [command] }),
    ],
  });
  await cli(args, root, { ...cliOptions, subCommands: root.subCommands });
  return result;
}

for (const [args, yes] of [
  [["--yes"], true],
  [["--yes=true"], true],
  [["--yes=false"], false],
  [["--yes=false", "--yes"], true],
  [["--yes", "--yes=false"], false],
  [["-y"], true],
  [["-y=false"], false],
] as const) {
  test(`boolean switches preserve ${args.join(" ")}`, async () => {
    expect(await parse(["group", "probe", ...args])).toMatchObject({
      flags: { yes, limit: 10 },
    });
  });
}

test("literal no- flag is not treated as a negation", async () => {
  expect(await parse(["group", "probe", "--no-bundle"])).toMatchObject({
    flags: { "no-bundle": true },
  });
  expect(await parse(["group", "probe", "--no-bundle=false"])).toMatchObject({
    flags: { "no-bundle": false },
  });
});

test("payload strings and arguments after -- do not enable switches", async () => {
  expect(
    await parse(["group", "probe", "--payload=--yes=true", "--", "--yes=true"]),
  ).toEqual({
    flags: {
      yes: false,
      "no-bundle": undefined,
      payload: "--yes=true",
      limit: 10,
    },
    positional: ["--yes=true"],
  });
});

test("nested command names are excluded from positional arguments", async () => {
  expect(
    await parse(["group", "probe", "run-id", "--yes=false"]),
  ).toMatchObject({ positional: ["run-id"] });
});

for (const args of [
  ["group", "probe", "--yes=maybe"],
  ["group", "probe", "--yes="],
  ["group", "probe", "--payload"],
  ["group", "probe", "--typo"],
  ["group", "probe", "--limit", "0"],
  ["group", "probe", "--limit="],
  ["group", "missing"],
]) {
  test(`rejects invalid input before handler: ${args.join(" ")}`, async () => {
    await expect(parse(args)).rejects.toThrow();
  });
}

test("groups and leaf commands expose generated help", async () => {
  const leaf = defineCommand({
    name: "leaf",
    description: "A leaf",
    handler: () => {
      throw new Error("must not execute");
    },
  });
  const root = defineGroup({
    name: "hooka",
    description: "Hooka",
    commands: [
      defineGroup({ name: "group", description: "A group", commands: [leaf] }),
    ],
  });
  expect(
    await cli(["group"], root, {
      ...cliOptions,
      subCommands: root.subCommands,
    }),
  ).toContain("leaf");
  expect(
    await cli(["group", "leaf", "--help"], root, {
      ...cliOptions,
      subCommands: root.subCommands,
    }),
  ).toContain("A leaf");
});

test("explicit string values and repeated options preserve the last value", async () => {
  expect(await parse(["group", "probe", "--payload="])).toMatchObject({
    flags: { payload: "" },
  });
  expect(
    await parse(["group", "probe", "--payload=first", "--payload", "last"]),
  ).toMatchObject({ flags: { payload: "last" } });
});
