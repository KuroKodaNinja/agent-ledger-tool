import { expect, test } from "bun:test";
import { readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { LedgerError } from "../tools/src/errors.ts";
import type { JsonObject } from "../tools/src/json.ts";
import { writeKernelRecord } from "../tools/src/scaffold.ts";
import { ledger, ledgerWithRun, withoutSuperuser } from "./support.ts";

const RUN = "projects/alpha/runs/first";
const CONTRACT = "projects/alpha/contracts/pr1";
const halt = { schema: "halt@1", date: "2026-10-30", cause: "operator-stop", goals: [CONTRACT] };
const state = { schema: "goal-state@1", date: "2026-10-30", goal: CONTRACT, phase: "pending" };
const decision = { schema: "budget-decision@1", date: "2026-10-30", request: `${RUN}/requests/1.json`, outcome: "approved", ceiling: 1000000000, reason: "Granted." };
const ROUND = `${RUN}/goals/pr1/rounds/a1-r1.json`;
const vouch = { schema: "vouch@1", date: "2026-10-30", round: ROUND, seat: "security", cause: "no runtime", evidence: `${CONTRACT}/evidence/demo.md`, blob: "b".repeat(40), reason: "The demo stands in." };
const finding = { severity: "high", detail: "The write accepts the operator's kinds.", remediation: "List the kinds by writer and refuse the operator's." };
const architect = { role: "architect", model: "gpt-6-astra", effort: "high", vote: "fail", confidence: 0.8, findings: [finding] };
const round = { schema: "round@1", date: "2026-10-30", attempt: `${RUN}/goals/pr1/attempts/a1.json`, commit: "c".repeat(40), profile: "code", seats: [architect], passed: false };

// Every entry under `dir`, however deep, relative to it.
const entriesUnder = (dir: string): string[] => readdirSync(dir, { recursive: true, encoding: "utf8" }).sort();

// The message the kernel's write refuses `record` at `path` with.
function refusal(root: string, path: string, record: JsonObject): string {
  try {
    writeKernelRecord(root, { path, record });
  } catch (error) {
    if (error instanceof LedgerError) return error.message;
    throw error;
  }
  throw new Error(`${path} was written`);
}

test("the kernel's write puts one record inside a run, creating the directories it names, and nothing else, so the ledger stays valid", () => {
  const root = ledgerWithRun();
  expect(entriesUnder(join(root, RUN))).toStrictEqual(["run.json"]);
  expect(writeKernelRecord(root, { path: `${RUN}/halt.json`, record: halt })).toBe(`${RUN}/halt.json`);
  expect(writeKernelRecord(root, { path: `${RUN}/goals/pr1/state.json`, record: state })).toBe(`${RUN}/goals/pr1/state.json`);
  expect(readFileSync(join(root, RUN, "halt.json"), "utf8")).toBe(`${JSON.stringify(halt, null, 2)}\n`);
  expect(entriesUnder(join(root, RUN))).toStrictEqual(["goals", "goals/pr1", "goals/pr1/state.json", "halt.json", "run.json"]);
  expect(ledger(["validate"], root)).toMatchObject({ code: 0, stdout: "the ledger is valid\n" });
});

test("the kernel's write writes a round, every seat's vote as cast, and the written record passes validate", () => {
  const root = ledgerWithRun();
  expect(writeKernelRecord(root, { path: ROUND, record: round })).toBe(ROUND);
  expect(JSON.parse(readFileSync(join(root, ROUND), "utf8"))).toStrictEqual(round);
  expect(ledger(["validate"], root)).toMatchObject({ code: 0, stdout: "the ledger is valid\n" });
});

test("the kernel's write refuses the operator's kinds, an invalid record, a path outside the ledger or outside a run or already taken, and a write the ledger would not be valid with, writing nothing", () => {
  const root = ledgerWithRun();
  writeKernelRecord(root, { path: `${RUN}/halt.json`, record: halt });
  const before = entriesUnder(join(root, RUN));
  const writes = "which a kernel does not write; a kernel writes attempt, round, budget-grant, budget-request, attestation, landing, goal-state, halt";
  const notInRun = "does not belong in a run: a run holds <name>.json records, in directories named in lowercase letters, digits, and hyphens";
  const refusals: readonly (readonly [string, JsonObject, string])[] = [
    [`${RUN}/decisions/1.json`, decision, `${RUN}/decisions/1.json: schema: is a budget-decision record, ${writes}`],
    [`${RUN}/vouches/1.json`, vouch, `${RUN}/vouches/1.json: schema: is a vouch record, ${writes}`],
    [`${RUN}/limits/2.json`, { schema: "limits@1" }, `${RUN}/limits/2.json: schema: is a limits record, ${writes}`],
    [`${RUN}/goals/pr1/state.json`, { ...state, schema: "plan@1" }, `${RUN}/goals/pr1/state.json: schema: is a plan record, ${writes}`],
    [`${RUN}/goals/pr1/state.json`, { ...state, schema: "goal-state" }, `${RUN}/goals/pr1/state.json: schema: must name a kind and major version, such as limits@1`],
    [`${RUN}/goals/pr1/state.json`, { ...state, phase: "flying" }, `${RUN}/goals/pr1/state.json: phase: must be one of "pending", "blocked", "building", "collecting", "judging", "failed-round", "deciding", "passed", "landing", "delivered", "merged", "failed", "dropped"`],
    [ROUND, { ...round, seats: [{ ...architect, confidence: 2 }] }, `${ROUND}: seats[0].confidence: must be at most 1`],
    [ROUND, { ...round, seats: [{ ...architect, vote: "inconclusive" }] }, `${ROUND}: seats[0].cause: is required`],
    [`${RUN}/../../x.json`, halt, `${RUN}/../../x.json: is not a path inside the ledger`],
    [`/${RUN}/x.json`, halt, `/${RUN}/x.json: is not a path inside the ledger`],
    ["projects/alpha/plans/x.json", halt, "projects/alpha/plans/x.json is not inside a run"],
    ["projects/alpha/runs/second/x.json", halt, "projects/alpha/runs/second/x.json is not inside a run"],
    [`${RUN}/run.json`, halt, `${RUN}/run.json already exists`],
    [`${RUN}/halt.json`, halt, `${RUN}/halt.json already exists`],
    [`${RUN}/Upper.json`, halt, `${RUN}/Upper.json would leave the ledger invalid: ${RUN}/Upper.json: ${notInRun}`],
    [`${RUN}/new/linked.json`, { ...halt, links: ["projects/ghost"] }, `${RUN}/new/linked.json would leave the ledger invalid: ${RUN}/new/linked.json: links: no record at projects/ghost`],
  ];
  for (const [path, record, message] of refusals) {
    expect(refusal(root, path, record)).toBe(message);
    expect(entriesUnder(join(root, RUN))).toStrictEqual(before);
  }
  expect(entriesUnder(join(root, "projects/alpha"))).not.toContain("plans");
  expect(ledger(["validate"], root)).toMatchObject({ code: 0, stdout: "the ledger is valid\n" });

  writeFileSync(join(root, RUN, "run.json"), "{ not json");
  expect(refusal(root, `${RUN}/goals/pr1/state.json`, state)).toBe("the ledger is not valid; run ledger validate");
  expect(entriesUnder(join(root, RUN))).toStrictEqual(before);
});

withoutSuperuser("a write the ledger cannot be inspected with is taken back too", () => {
  const root = ledgerWithRun();
  // Everything made under this mask has no permission at all, so the written file cannot be read back.
  const mask = process.umask(0o777);
  try {
    expect(refusal(root, `${RUN}/halt.json`, halt)).toBe(`${RUN}/halt.json was taken back: the ledger could not be inspected with it`);
  } finally {
    process.umask(mask);
  }
  expect(entriesUnder(join(root, RUN))).toStrictEqual(["run.json"]);
  expect(ledger(["validate"], root)).toMatchObject({ code: 0, stdout: "the ledger is valid\n" });
});
