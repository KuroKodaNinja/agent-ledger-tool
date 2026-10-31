#!/usr/bin/env bun
/** The ledger command line: parses the arguments, runs one command, and owns every message and exit code. */
import { parseArgs } from "node:util";
import { LedgerError, UsageError } from "./src/errors.ts";
import { printable } from "./src/json.ts";
import { DocKind, findRoot, OwnerKind, RunKind, SCHEMA_DIR } from "./src/layout.ts";
import { createDocument, createProgram, createProject, createRun } from "./src/scaffold.ts";
import { loadSchemas, type SchemaSet } from "./src/schema.ts";
import { inspectLedger } from "./src/validate.ts";

const USAGE = `usage:
  ledger validate
  ledger new project <name> --title <title> --summary <summary> [--repository <owner/name>]
  ledger new program <name> --title <title> --summary <summary> --projects <name,...>
  ledger new <plan|decision|contract|research|handoff> <name> --in <projects/name|programs/name> --title <title> [--date <YYYY-MM-DD>]
  ledger new run <program> --in <projects/name> --title <title> [--date <YYYY-MM-DD>]
every command also takes --root <dir>`;

/** How the process ends. */
const ExitCode = { Ok: 0, Refused: 1, Usage: 2 } as const;

/** The commands the tool runs. */
const Command = { Validate: "validate", New: "new" } as const;

/** What `new` creates. */
type Creatable = OwnerKind | DocKind | RunKind;

const DOCUMENT_OPTIONS = ["root", "in", "title", "date"];
/** The options `validate` and each kind of `new` take. */
const OPTIONS: Readonly<Record<typeof Command.Validate | Creatable, readonly string[]>> = {
  [Command.Validate]: ["root"],
  [OwnerKind.Project]: ["root", "title", "summary", "repository"],
  [OwnerKind.Program]: ["root", "title", "summary", "projects"],
  [DocKind.Plan]: DOCUMENT_OPTIONS,
  [DocKind.Decision]: DOCUMENT_OPTIONS,
  [DocKind.Contract]: DOCUMENT_OPTIONS,
  [DocKind.Research]: DOCUMENT_OPTIONS,
  [DocKind.Handoff]: DOCUMENT_OPTIONS,
  [RunKind.Run]: DOCUMENT_OPTIONS,
};

function isCreatable(value: string | undefined): value is Creatable {
  return value !== undefined && value !== Command.Validate && Object.hasOwn(OPTIONS, value);
}

// Today, where the tool runs: Canada's English format is YYYY-MM-DD.
const today = (): string => new Date().toLocaleDateString("en-CA");

function create(root: string, schemas: SchemaSet, kind: Creatable, name: string, values: Readonly<Record<string, string | undefined>>): string {
  const input = { name, title: required(values.title, "--title") };
  if (kind === OwnerKind.Project) {
    const repository = values.repository === undefined ? {} : { repository: values.repository };
    return createProject(root, schemas, { ...input, summary: required(values.summary, "--summary"), ...repository });
  }
  if (kind === OwnerKind.Program) {
    const projects = required(values.projects, "--projects").split(",").filter((p) => p !== "");
    return createProgram(root, schemas, { ...input, summary: required(values.summary, "--summary"), projects });
  }
  const dated = { ...input, owner: required(values.in, "--in"), date: values.date ?? today() };
  if (kind === RunKind.Run) return createRun(root, schemas, dated);
  return createDocument(root, schemas, { ...dated, kind });
}

function required(value: string | undefined, what: string): string {
  if (value === undefined || value === "") throw new UsageError(`${what} is required`);
  return value;
}

function validate(root: string, schemas: SchemaSet): number {
  const { problems } = inspectLedger(root, schemas);
  // A problem names fields from the record, which may hold any character.
  for (const problem of problems) console.log(printable(`${problem.path}: ${problem.message}`));
  const count = `${problems.length} problem${problems.length === 1 ? "" : "s"}`;
  console.log(problems.length === 0 ? "the ledger is valid" : count);
  return problems.length === 0 ? ExitCode.Ok : ExitCode.Refused;
}

function main(argv: readonly string[]): number {
  const { values, positionals } = parseArgs({
    args: [...argv],
    allowPositionals: true,
    options: {
      root: { type: "string" },
      title: { type: "string" },
      summary: { type: "string" },
      repository: { type: "string" },
      projects: { type: "string" },
      in: { type: "string" },
      date: { type: "string" },
    },
  });
  const [command, ...rest] = positionals;
  if (command === undefined) throw new UsageError("a command is required");
  if (command !== Command.Validate && command !== Command.New) throw new UsageError(`unknown command ${JSON.stringify(command)}`);
  const kind = command === Command.New ? rest.shift() : undefined;
  if (command === Command.New && !isCreatable(kind)) throw new UsageError(`new: unknown kind ${JSON.stringify(kind ?? "")}`);
  const name = command === Command.New ? rest.shift() : undefined;
  const options = isCreatable(kind) ? OPTIONS[kind] : OPTIONS[Command.Validate];
  const unusable = Object.keys(values).find((option) => !options.includes(option));
  if (unusable !== undefined) throw new UsageError(`${[command, kind].filter(Boolean).join(" ")} takes no --${unusable}`);
  if (rest[0] !== undefined) throw new UsageError(`unexpected argument ${JSON.stringify(rest[0])}`);
  const root = values.root ?? findRoot(process.cwd());
  const schemas = loadSchemas(SCHEMA_DIR);
  if (!isCreatable(kind)) return validate(root, schemas);
  console.log(printable(`created ${create(root, schemas, kind, required(name, "a name"), values)}`));
  return ExitCode.Ok;
}

// parseArgs signals an argument it cannot use with a TypeError carrying an ERR_PARSE_ARGS code.
function isArgumentError(error: unknown): error is Error {
  const parseArgsError =
    error instanceof TypeError && "code" in error && String(error.code).startsWith("ERR_PARSE_ARGS");
  return error instanceof UsageError || parseArgsError;
}

try {
  process.exitCode = main(Bun.argv.slice(2));
} catch (error) {
  if (isArgumentError(error)) {
    console.error(printable(`error: ${error.message}`));
    console.error(USAGE);
    process.exitCode = ExitCode.Usage;
  } else if (error instanceof LedgerError) {
    console.error(printable(`error: ${error.message}`));
    process.exitCode = ExitCode.Refused;
  } else {
    throw error;
  }
}
