import { expect, test } from "bun:test";
import { mkdirSync, readdirSync, readFileSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { ledger, ledgerWithOwners, problems, toolWithShippedSchemas, writeDocument, writeJson } from "./support.ts";

const RUN = "projects/alpha/runs/first";
const DATE = "2026-10-29";

const vouch = {
  schema: "vouch@1",
  date: DATE,
  round: `${RUN}/goals/g1/rounds/a1-r1.json`,
  seat: "security",
  cause: "no Apple runtime in the sandbox",
  evidence: "projects/alpha/contracts/pr1/evidence/demo.md",
  blob: "b".repeat(40),
  reason: "The committed demo repeats the probe the seat could not run.",
};

test("new run creates a run under a project, and the run's records validate by the kinds their own schema fields name", () => {
  const root = ledgerWithOwners();
  expect(ledger(["new", "run", "first", "--in", "projects/alpha", "--title", "The first program", "--date", DATE], root)).toStrictEqual({
    code: 0,
    stdout: `created ${RUN}\n`,
    stderr: "",
  });
  expect(JSON.parse(readFileSync(join(root, RUN, "run.json"), "utf8"))).toStrictEqual({ schema: "run@1", title: "The first program", date: DATE, status: "open", contracts: [] });
  writeJson(join(root, RUN, "vouches/1.json"), vouch);
  writeJson(join(root, RUN, "goals/g1/vouches/security.json"), { ...vouch, seat: "architect" });
  expect(ledger(["validate"], root)).toMatchObject({ code: 0, stdout: "the ledger is valid\n" });
});

test("new run refuses an owner that is not a project, a taken name, a bad name, and an option it does not take, writing nothing", () => {
  const root = ledgerWithOwners();
  ledger(["new", "run", "first", "--in", "projects/alpha", "--title", "First"], root);
  const refusals: readonly (readonly [readonly string[], number, string])[] = [
    [["run", "first", "--in", "programs/group", "--title", "X"], 1, "error: no project at programs/group\n"],
    [["run", "first", "--in", "projects/alpha", "--title", "Again"], 1, `error: ${RUN} already exists\n`],
    [["run", "x", "--in", "projects/ghost", "--title", "X"], 1, "error: no project at projects/ghost\n"],
    [["run", "Bad_Name", "--in", "projects/alpha", "--title", "X"], 2, 'error: run name "Bad_Name": use lowercase letters, digits, and hyphens, starting with a letter or digit\n'],
    [["run", "x", "--in", "projects/alpha", "--title", "X", "--summary", "s"], 2, "error: new run takes no --summary\n"],
    [["run", "x", "--title", "X"], 2, "error: --in is required\n"],
  ];
  for (const [args, code, stderr] of refusals) {
    const run = ledger(["new", ...args], root);
    expect(run.code).toBe(code);
    expect(`${run.stderr.split("\n")[0]}\n`).toBe(stderr);
  }
  expect(readdirSync(join(root, "projects/alpha/runs"))).toStrictEqual(["first"]);
});

test("everything in a run that is not a record of a kind a run holds is reported at its path, and a run belongs only to a project", () => {
  const root = ledgerWithOwners();
  ledger(["new", "run", "first", "--in", "projects/alpha", "--title", "First"], root);
  writeFileSync(join(root, RUN, "notes.txt"), "stray");
  writeJson(join(root, RUN, "plan.json"), { schema: "plan@1", title: "P", date: DATE, status: "draft" });
  writeJson(join(root, RUN, "old.json"), { ...vouch, schema: "vouch@9" });
  writeJson(join(root, RUN, "bad.json"), { ...vouch, blob: "not-a-hash", extra: 1 });
  writeFileSync(join(root, RUN, "broken.json"), "{ not json");
  writeFileSync(join(root, RUN, "none.json"), "[1]");
  writeJson(join(root, RUN, "unnamed.json"), { title: "x" });
  mkdirSync(join(root, RUN, "empty"));
  mkdirSync(join(root, RUN, "outer/inner"), { recursive: true });
  mkdirSync(join(root, RUN, "Upper"));
  writeJson(join(root, RUN, "Upper.json"), vouch);
  symlinkSync(join(root, "ledger.json"), join(root, RUN, "link.json"));
  mkdirSync(join(root, "projects/alpha/runs/second"));
  writeFileSync(join(root, "projects/alpha/runs/loose.json"), "{}");
  mkdirSync(join(root, "programs/group/runs/x"), { recursive: true });

  const notInRun = "does not belong in a run: a run holds <name>.json records, in directories named in lowercase letters, digits, and hyphens";
  expect(problems(ledger(["validate"], root))).toStrictEqual([
    "programs/group/runs: does not belong in a program",
    `${RUN}/bad.json: blob: is not in the required form`,
    `${RUN}/bad.json: extra: is not a field of this record`,
    `${RUN}/broken.json: is not JSON`,
    `${RUN}/empty: holds no record`,
    `${RUN}/link.json: must be a file, not a link or a directory`,
    `${RUN}/none.json: must be an object`,
    `${RUN}/notes.txt: ${notInRun}`,
    `${RUN}/old.json: schema: vouch@9 is not a version the ledger accepts`,
    `${RUN}/outer: holds no record`,
    `${RUN}/outer/inner: holds no record`,
    `${RUN}/plan.json: schema: is a plan record, which a run does not hold; a run holds limits, budget-decision, vouch, attempt, round, budget-grant, budget-request, attestation, landing, goal-state, halt`,
    `${RUN}/unnamed.json: schema: must name a kind and major version, such as limits@1`,
    `${RUN}/Upper: ${notInRun}`,
    `${RUN}/Upper.json: ${notInRun}`,
    "projects/alpha/runs/loose.json: does not belong here: runs/ holds only <program> directories, named in lowercase letters, digits, and hyphens",
    "projects/alpha/runs/second/run.json: is missing",
  ]);
});

test("a document's links reach a run and the records inside it, and a run's contracts name contracts that exist", () => {
  const root = ledgerWithOwners();
  ledger(["new", "run", "first", "--in", "projects/alpha", "--title", "First", "--date", DATE], root);
  ledger(["new", "contract", "pr1", "--in", "projects/alpha", "--title", "PR 1"], root);
  writeJson(join(root, RUN, "vouches/1.json"), vouch);
  const plan = (links: readonly string[]) => ({ schema: "plan@1", title: "P", date: DATE, status: "draft", links });
  writeDocument(root, "projects/alpha/plans/linked.md", plan([RUN, `${RUN}/vouches/1.json`]));
  writeJson(join(root, RUN, "run.json"), { schema: "run@1", title: "First", date: DATE, status: "open", contracts: ["projects/alpha/contracts/pr1"], links: ["programs/group"] });
  expect(ledger(["validate"], root)).toMatchObject({ code: 0, stdout: "the ledger is valid\n" });

  writeDocument(root, "projects/alpha/plans/linked.md", plan([RUN, `${RUN}/vouches/2.json`, `${RUN}/run.json`]));
  writeJson(join(root, RUN, "run.json"), { schema: "run@1", title: "First", date: DATE, status: "open", contracts: ["projects/alpha/contracts/pr2", "projects/alpha", RUN], links: ["programs/ghost"] });
  expect(problems(ledger(["validate"], root))).toStrictEqual([
    `projects/alpha/plans/linked.md: links: no record at ${RUN}/run.json`,
    `projects/alpha/plans/linked.md: links: no record at ${RUN}/vouches/2.json`,
    `${RUN}/run.json: contracts: no contract at projects/alpha`,
    `${RUN}/run.json: contracts: no contract at projects/alpha/contracts/pr2`,
    `${RUN}/run.json: contracts: no contract at ${RUN}`,
    `${RUN}/run.json: links: no record at programs/ghost`,
  ]);
});

test("a hyphenated kind name is accepted, and a run record of such a kind validates against the schema the ledger holds for its version", () => {
  const decision2 = {
    type: "object",
    required: ["schema", "note"],
    additionalProperties: false,
    properties: { schema: { const: "budget-decision@2" }, note: { type: "string", minLength: 1 } },
  };
  const tool = toolWithShippedSchemas({ "budget-decision@2.json": decision2 });
  const root = ledgerWithOwners();
  ledger(["new", "run", "first", "--in", "projects/alpha", "--title", "First"], root);
  writeJson(join(root, RUN, "decisions/1.json"), { schema: "budget-decision@2", note: "approved" });
  expect(ledger(["validate"], root, tool)).toMatchObject({ code: 0, stdout: "the ledger is valid\n" });
  expect(problems(ledger(["validate"], root))).toStrictEqual([`${RUN}/decisions/1.json: schema: budget-decision@2 is not a version the ledger accepts`]);
  writeJson(join(root, RUN, "decisions/1.json"), { schema: "budget-decision@2" });
  expect(problems(ledger(["validate"], root, tool))).toStrictEqual([`${RUN}/decisions/1.json: note: is required`]);
});
