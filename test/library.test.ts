import { expect, test } from "bun:test";
import { chmodSync, cpSync, mkdtempSync, readdirSync, realpathSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import manifest from "../package.json";
import { ledger, ledgerWithRun } from "./support.ts";

const ROOT = realpathSync(join(import.meta.dir, ".."));
const RUN = "projects/alpha/runs/first";
// The script a dependant runs: it imports the ledger by the package's name and reports what it found and did.
const DEPENDANT_SCRIPT = join(import.meta.dir, "fixtures", "dependant", "check.ts");

// Every name the library exports at run time, which is the whole surface less its types.
const SURFACE = ["FOLDERS", "KERNEL_RECORD_KINDS", "LedgerError", "OPERATOR_RECORD_KINDS", "OwnerKind", "RUN_FILE", "SCHEMA_DIR", "inspectLedger", "loadSchemas", "writeKernelRecord"];

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

// A package depending on the ledger as it ships: the artifact `bun pm pack`
// makes of what the manifest names, its manifest exactly, packed from a
// writable copy since bun will not pack a read-only tree, installed by path
// with bun into a dependant that has an empty cache and no network.
function dependant(): string {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), "ledger-dependant-")));
  const source = join(dir, "source");
  for (const shipped of ["package.json", ...manifest.files]) cpSync(join(ROOT, shipped), join(source, shipped), { recursive: true });
  // The copy keeps the source's modes, so a read-only checkout gives a read-only manifest, which bun will not pack.
  chmodSync(join(source, "package.json"), 0o644);
  const pack = Bun.spawnSync(["bun", "pm", "pack", "--quiet", "--destination", dir], { cwd: source, stdout: "pipe", stderr: "pipe" });
  if (pack.exitCode !== 0) throw new Error(`bun pm pack failed: ${pack.stderr.toString()}`);
  const artifact = readdirSync(dir).find((name) => name.endsWith(".tgz"));
  if (artifact === undefined) throw new Error("bun pm pack made no artifact");
  writeFileSync(join(dir, "package.json"), JSON.stringify({ name: "dependant", dependencies: { [manifest.name]: `file:${artifact}` } }));
  const coldCache = join(dir, "empty-cache");
  const install = Bun.spawnSync(["bun", "install", "--offline", "--no-summary"], { cwd: dir, stdout: "pipe", stderr: "pipe", env: { ...process.env, BUN_INSTALL_CACHE_DIR: coldCache } });
  if (install.exitCode !== 0) throw new Error(`bun install in the dependant failed: ${install.stderr.toString()}`);
  cpSync(DEPENDANT_SCRIPT, join(dir, "check.ts"));
  return dir;
}

test("a dependant that installed the ledger as it ships, by path, cold and offline, imports it by name and gets exactly the surface, frozen tables, a kernel record written and inspected, and the operator's kinds and deep imports refused", () => {
  const dir = dependant();
  expect(readdirSync(join(dir, "node_modules", manifest.name)).sort()).toStrictEqual(["package.json", ...manifest.files].sort());
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
