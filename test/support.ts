import { test } from "bun:test";
import { cpSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

/** A test that takes a permission away, which a superuser would not feel, so it is skipped as one. */
export const withoutSuperuser = test.skipIf(process.getuid?.() === 0);

/** The ledger tool, run as a user runs it. */
export const TOOL = join(import.meta.dir, "..", "tools", "ledger.ts");

/** What one run of the tool printed and how it exited. */
export interface Run {
  /** The exit code, or null when a signal ended the run. */
  readonly code: number | null;
  /** Everything written to standard output. */
  readonly stdout: string;
  /** Everything written to standard error. */
  readonly stderr: string;
}

/** Runs the ledger tool under test with `args` in `cwd`. */
export function ledger(args: readonly string[], cwd: string): Run {
  const result = Bun.spawnSync([process.execPath, TOOL, ...args], { cwd, stdout: "pipe", stderr: "pipe" });
  return { code: result.exitCode, stdout: result.stdout.toString(), stderr: result.stderr.toString() };
}

/** The manifest of a valid, empty ledger. */
export const LEDGER_MANIFEST = { schema: "ledger@1", name: "test-ledger", title: "A ledger for a test" };

/** The schemas the tests' ledgers carry: one ledger's set, kept as data under the fixtures. */
export const FIXTURE_SCHEMAS = join(import.meta.dir, "fixtures", "schema");

/**
 * A ledger in its own temporary directory whose schema directory holds exactly `schemas`, each written as
 * given: a string as the file's text, anything else as JSON. Its manifest is `manifest`. Returns its root.
 */
export function ledgerWithSchemas(schemas: Readonly<Record<string, unknown>>, manifest: unknown = LEDGER_MANIFEST): string {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "ledger-test-")));
  writeJson(join(root, "ledger.json"), manifest);
  mkdirSync(join(root, "schema"));
  for (const [name, schema] of Object.entries(schemas)) {
    writeFileSync(join(root, "schema", name), typeof schema === "string" ? schema : JSON.stringify(schema));
  }
  return root;
}

/**
 * A ledger in its own temporary directory carrying the fixture schemas changed by `changes`: each schema file
 * named is written as JSON, or removed when its value is null. Returns its root.
 */
export function ledgerWithChangedSchemas(changes: Readonly<Record<string, unknown>>, manifest: unknown = LEDGER_MANIFEST): string {
  const root = ledgerWithSchemas({}, manifest);
  cpSync(FIXTURE_SCHEMAS, join(root, "schema"), { recursive: true });
  for (const [name, schema] of Object.entries(changes)) {
    if (schema === null) rmSync(join(root, "schema", name));
    else writeFileSync(join(root, "schema", name), JSON.stringify(schema));
  }
  return root;
}

/** A fresh, empty, valid ledger in its own temporary directory, carrying the fixture schemas. */
export function emptyLedger(manifest: unknown = LEDGER_MANIFEST): string {
  return ledgerWithChangedSchemas({}, manifest);
}

/** A ledger holding project alpha and program group, which spans it. */
export function ledgerWithOwners(): string {
  const root = emptyLedger();
  ledger(["new", "project", "alpha", "--title", "Alpha", "--summary", "s"], root);
  ledger(["new", "program", "group", "--title", "Group", "--summary", "s", "--projects", "alpha"], root);
  return root;
}

/** A ledger holding project alpha with its contract pr1, program group spanning alpha, and alpha's run first, dated 2026-10-30. */
export function ledgerWithRun(): string {
  const root = ledgerWithOwners();
  ledger(["new", "contract", "pr1", "--in", "projects/alpha", "--title", "PR 1"], root);
  ledger(["new", "run", "first", "--in", "projects/alpha", "--title", "First", "--date", "2026-10-30"], root);
  return root;
}

/** Writes `value` as JSON to `file`, creating its directory. */
export function writeJson(file: string, value: unknown): void {
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, `${JSON.stringify(value, null, 2)}\n`);
}

/** Writes a document at `path` in the ledger at `root`: `fields` as its frontmatter, then `body`. */
export function writeDocument(root: string, path: string, fields: Readonly<Record<string, unknown>>, body = "Text.\n"): void {
  mkdirSync(dirname(join(root, path)), { recursive: true });
  const frontmatter = Object.entries(fields).map(([key, value]) => `${key}: ${JSON.stringify(value)}`);
  writeFileSync(join(root, path), `---\n${frontmatter.join("\n")}\n---\n\n${body}`);
}

/** The problems `validate` reported, one per line, without its closing count. */
export function problems(run: Run): readonly string[] {
  return run.stdout.trim().split("\n").slice(0, -1);
}
