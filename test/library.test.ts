import { expect, test } from "bun:test";
import { cpSync, mkdtempSync, readdirSync, realpathSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import manifest from "../package.json";
import { ledger, ledgerWithRun } from "./support.ts";

const ROOT = realpathSync(join(import.meta.dir, ".."));
const RUN = "projects/alpha/runs/first";
// The script a dependant runs: it imports the ledger by the package's name and reports what it found and did.
const DEPENDANT_SCRIPT = join(import.meta.dir, "fixtures", "dependant", "check.ts");

// Every name the library exports at run time, which is the whole surface less its types.
const SURFACE = ["FOLDERS", "KERNEL_RECORD_KINDS", "LedgerError", "OPERATOR_RECORD_KINDS", "OwnerKind", "RUN_FILE", "inspectLedger", "ledgerSchemas", "loadSchemas", "writeKernelRecord"];

/** What the dependant's script reports, field by field. */
interface Report {
  readonly surface: readonly string[];
  readonly written: string;
  readonly problems: readonly unknown[];
  readonly held: readonly (readonly string[])[];
  readonly kernelWrites: readonly string[];
  readonly writtenTwice: string;
  readonly frozen: boolean;
  readonly widened: string;
  readonly operatorKind: string;
  readonly deep: Readonly<Record<string, boolean>>;
}

// Runs `command` in `cwd` to its end and requires it to succeed.
function succeed(command: readonly string[], cwd: string, env: Record<string, string | undefined> = process.env): void {
  const result = Bun.spawnSync([...command], { cwd, env, stdout: "pipe", stderr: "pipe" });
  if (result.exitCode !== 0) throw new Error(`${command.join(" ")} failed: ${result.stderr.toString()}`);
}

// Git with the fixtures' identity, so no test depends on the machine's.
const GIT = ["git", "-c", "user.name=fixture", "-c", "user.email=fixture@example.invalid"];

// A package depending on this repository as it is now, as a dependant
// names it: a git dependency at one commit, the commit of a repository made
// on the disk from the tree under test, so no network is touched and
// nothing waits to be committed, installed with bun into a dependant that
// has an empty cache and no credential.
function dependant(): string {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), "ledger-dependant-")));
  const source = join(dir, "source");
  for (const shipped of ["package.json", "bun.lock", "tsconfig.json", ...manifest.files]) cpSync(join(ROOT, shipped), join(source, shipped), { recursive: true });
  succeed([...GIT, "init", "--quiet", "--initial-branch", "main"], source);
  succeed([...GIT, "add", "--all"], source);
  succeed([...GIT, "commit", "--quiet", "--message", "the tree under test"], source);
  const commit = Bun.spawnSync([...GIT, "rev-parse", "HEAD"], { cwd: source, stdout: "pipe", stderr: "pipe" }).stdout.toString().trim();
  const bare = join(dir, "repository.git");
  succeed([...GIT, "clone", "--quiet", "--bare", "--", source, bare], dir);
  writeFileSync(join(dir, "package.json"), JSON.stringify({ name: "dependant", dependencies: { [manifest.name]: `git+file://${bare}#${commit}` } }));
  succeed(["bun", "install", "--no-summary"], dir, { ...process.env, BUN_INSTALL_CACHE_DIR: join(dir, "empty-cache"), GIT_TERMINAL_PROMPT: "0" });
  cpSync(DEPENDANT_SCRIPT, join(dir, "check.ts"));
  return dir;
}

test("a dependant that installed this repository, as it is now, at a commit, with an empty cache and no credential, imports it by name and gets exactly the surface, frozen tables, a kernel record written and inspected, and the operator's kinds and deep imports refused", () => {
  const dir = dependant();
  expect(readdirSync(join(dir, "node_modules", manifest.name))).toEqual(expect.arrayContaining(["package.json", ...manifest.files]));
  const root = ledgerWithRun();
  const run = Bun.spawnSync(["bun", "check.ts", root, RUN], { cwd: dir, stdout: "pipe", stderr: "pipe" });
  expect(run.stderr.toString()).toBe("");
  expect(run.exitCode).toBe(0);
  const report: Report = JSON.parse(run.stdout.toString());
  expect(report.surface).toStrictEqual(SURFACE);
  expect(report.written).toBe(`${RUN}/halt.json`);
  expect(report.problems).toStrictEqual([]);
  expect(report.held).toStrictEqual([[`${RUN}/halt.json`]]);
  expect(report.kernelWrites).toContain("halt");
  expect(report.writtenTwice).toBe(`LedgerError: ${RUN}/halt.json already exists`);
  expect(report.frozen).toBe(true);
  expect(report.widened).toStartWith("TypeError: ");
  expect(report.operatorKind).toBe(`LedgerError: ${RUN}/decisions/1.json: schema: is a budget-decision record, which a kernel does not write; a kernel writes ${report.kernelWrites.join(", ")}`);
  expect(report.deep).toStrictEqual({ "tools/src/schema.ts": false, "tools/src/scaffold.ts": false, "tools/ledger.ts": false });
  expect(ledger(["validate"], root)).toMatchObject({ code: 0, stdout: "the ledger is valid\n" });
});
