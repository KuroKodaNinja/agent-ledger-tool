import { expect, test } from "bun:test";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { LedgerError } from "../tools/src/errors.ts";
import type { JsonObject } from "../tools/src/json.ts";
import { declareRun, type RunDeclaration, writeKernelRecord } from "../tools/src/scaffold.ts";
import { LIMITS, ledger, ledgerWithRun } from "./support.ts";

const RUN = "projects/alpha/runs/second";
const CONTRACT = "projects/alpha/contracts/pr1";
const REPOSITORY = { remote: "https://git.example/acme/widgets.git", branch: "main" };
const DECLARATION: RunDeclaration = { run: RUN, title: "Second", date: "2026-11-17", contracts: [CONTRACT], repository: REPOSITORY, limits: LIMITS };

// Every entry under `dir`, however deep, relative to it.
const entriesUnder = (dir: string): string[] => readdirSync(dir, { recursive: true, encoding: "utf8" }).sort();
const json = (root: string, path: string): unknown => JSON.parse(readFileSync(join(root, path), "utf8"));
// Every file in the ledger with what it holds, to show a refusal left it as it was.
const snapshot = (root: string): Record<string, string> => Object.fromEntries(entriesUnder(root).filter((entry) => entry.endsWith(".json") || entry.endsWith(".md")).map((entry) => [entry, readFileSync(join(root, entry), "utf8")]));

// The message `declareRun` refuses `declaration` with.
function refusal(root: string, declaration: RunDeclaration): string {
  try {
    declareRun(root, declaration);
  } catch (error) {
    if (error instanceof LedgerError) return error.message;
    throw error;
  }
  throw new Error(`${declaration.run} was declared`);
}

test("a run that does not exist is made, open, with its declaration and its limits as the first version, and the ledger stays valid", () => {
  const root = ledgerWithRun();
  expect(declareRun(root, DECLARATION)).toStrictEqual({ run: RUN, created: true, limits: 1 });
  expect(entriesUnder(join(root, RUN))).toStrictEqual(["limits", "limits/1.json", "run.json"]);
  expect(json(root, `${RUN}/run.json`)).toMatchObject({ schema: "run@1", title: "Second", date: "2026-11-17", status: "open", contracts: [CONTRACT], repository: REPOSITORY });
  expect(json(root, `${RUN}/limits/1.json`)).toStrictEqual(LIMITS);
  expect(ledger(["validate"], root).code).toBe(0);
});

test("a run that exists as declared writes nothing for equal limits, and the next version for limits that changed", () => {
  const root = ledgerWithRun();
  declareRun(root, DECLARATION);
  const before = snapshot(root);
  expect(declareRun(root, DECLARATION)).toStrictEqual({ run: RUN, created: false, limits: 1 });
  expect(snapshot(root)).toStrictEqual(before);
  const changed: JsonObject = { ...LIMITS, budget: { ...(LIMITS.budget as JsonObject), perGoal: 7200 } };
  expect(declareRun(root, { ...DECLARATION, limits: changed })).toStrictEqual({ run: RUN, created: false, limits: 2 });
  expect(json(root, `${RUN}/limits/2.json`)).toStrictEqual(changed);
  // Back to the first limits is a change from the latest, so a third version.
  expect(declareRun(root, DECLARATION)).toStrictEqual({ run: RUN, created: false, limits: 3 });
  expect(ledger(["validate"], root).code).toBe(0);
});

test("a run that declares other contracts or another repository is refused, naming the difference, and nothing is written", () => {
  const root = ledgerWithRun();
  ledger(["new", "contract", "pr2", "--in", "projects/alpha", "--title", "PR 2"], root);
  declareRun(root, DECLARATION);
  const before = snapshot(root);
  expect(refusal(root, { ...DECLARATION, contracts: [CONTRACT, "projects/alpha/contracts/pr2"] })).toBe(`${RUN}: already declares the contracts ["${CONTRACT}"], not ["${CONTRACT}","projects/alpha/contracts/pr2"]`);
  expect(refusal(root, { ...DECLARATION, repository: { ...REPOSITORY, branch: "next" } })).toContain(`${RUN}: already declares the repository`);
  expect(refusal(root, { ...DECLARATION, limits: { ...LIMITS, budget: { ...(LIMITS.budget as JsonObject), perGoal: 7200 } }, repository: { ...REPOSITORY, branch: "next" } })).toContain("already declares the repository");
  expect(snapshot(root)).toStrictEqual(before);
});

test("a run that exists is refused the same contracts in another order, since the order is the operator's", () => {
  const root = ledgerWithRun();
  const second = "projects/alpha/contracts/pr2";
  ledger(["new", "contract", "pr2", "--in", "projects/alpha", "--title", "PR 2"], root);
  declareRun(root, { ...DECLARATION, contracts: [CONTRACT, second] });
  const before = snapshot(root);
  expect(refusal(root, { ...DECLARATION, contracts: [second, CONTRACT] })).toBe(`${RUN}: already declares the contracts ["${CONTRACT}","${second}"], not ["${second}","${CONTRACT}"]`);
  expect(snapshot(root)).toStrictEqual(before);
  expect(declareRun(root, { ...DECLARATION, contracts: [CONTRACT, second] })).toStrictEqual({ run: RUN, created: false, limits: 1 });
});

test("a declaration the ledger would not be valid with leaves nothing: a contract it does not hold, limits the schema refuses, a project that does not exist, a path that is no run's", () => {
  const root = ledgerWithRun();
  const before = snapshot(root);
  expect(refusal(root, { ...DECLARATION, contracts: ["projects/alpha/contracts/absent"] })).toStartWith(`${RUN} would leave the ledger invalid:`);
  expect(refusal(root, { ...DECLARATION, limits: { ...LIMITS, budget: "lots" } })).toContain("budget");
  expect(refusal(root, { ...DECLARATION, limits: { schema: "halt@1", date: "2026-11-17", cause: "operator-stop", goals: [] } })).toBe(`${RUN}/limits: schema: must name a limits record`);
  expect(refusal(root, { ...DECLARATION, run: "projects/absent/runs/second" })).toBe("no project at projects/absent");
  expect(refusal(root, { ...DECLARATION, run: "projects/alpha/contracts/second" })).toBe("projects/alpha/contracts/second: is not a run's path, projects/<project>/runs/<name>");
  expect(snapshot(root)).toStrictEqual(before);
  expect(ledger(["validate"], root).code).toBe(0);
});

test("the kernel's general write still refuses the limits declareRun writes", () => {
  const root = ledgerWithRun();
  declareRun(root, DECLARATION);
  expect(() => writeKernelRecord(root, { path: `${RUN}/limits/2.json`, record: LIMITS })).toThrow("which a kernel does not write");
});
