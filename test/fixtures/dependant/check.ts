// Run inside a dependant of the ledger by the test that made it: imports the
// ledger by the package's name, as any dependant does, exercises the library
// against a scratch ledger, and prints what it found and did as JSON for the
// test to judge. Arguments: the scratch ledger's root, and the run to write
// into.
import * as ledger from "agent-ledger";

const [root, run] = process.argv.slice(2) as [string, string];
const halt = { schema: "halt@1", date: "2026-10-30", cause: "operator-stop", goals: ["projects/alpha/contracts/pr1"] };
const decision = { schema: "budget-decision@1", date: "2026-10-30", request: `${run}/requests/1.json`, outcome: "approved", ceiling: 1000000000, reason: "Granted." };

// What `work` is refused with, by the error's name and message, or that it was not.
function refusal(work: () => unknown): string {
  try {
    work();
    return "not refused";
  } catch (error) {
    return error instanceof Error ? `${error.name}: ${error.message}` : String(error);
  }
}

// Whether a module of the ledger resolves from here by its deep path, which the exports map should forbid.
function resolves(module: string): boolean {
  try {
    Bun.resolveSync(`agent-ledger/${module}`, import.meta.dir);
    return true;
  } catch {
    return false;
  }
}

const written = ledger.writeKernelRecord(root, { path: `${run}/halt.json`, record: halt });
const inspection = ledger.inspectLedger(root, ledger.loadSchemas(ledger.SCHEMA_DIR));
console.log(
  JSON.stringify({
    surface: Object.keys(ledger).sort(),
    written,
    problems: inspection.problems,
    held: inspection.runs.map((found) => found.records.map((record) => record.path)),
    kernelWrites: ledger.KERNEL_RECORD_KINDS,
    writtenTwice: refusal(() => ledger.writeKernelRecord(root, { path: `${run}/halt.json`, record: halt })),
    frozen: [ledger.KERNEL_RECORD_KINDS, ledger.OPERATOR_RECORD_KINDS, ledger.FOLDERS, ledger.OwnerKind].every((table) => Object.isFrozen(table)),
    widened: refusal(() => (ledger.KERNEL_RECORD_KINDS as string[]).push("budget-decision")),
    operatorKind: refusal(() => ledger.writeKernelRecord(root, { path: `${run}/decisions/1.json`, record: decision })),
    deep: Object.fromEntries(["tools/src/schema.ts", "tools/src/scaffold.ts", "tools/ledger.ts"].map((module) => [module, resolves(module)])),
  }),
);
