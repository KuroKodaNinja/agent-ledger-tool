import { expect, test } from "bun:test";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { ledger, ledgerWithRun, problems, writeJson } from "./support.ts";

const RUN = "projects/alpha/runs/first";
const CONTRACT = "projects/alpha/contracts/pr1";
const DATE = "2026-10-30";
const SHA = "c".repeat(40);

const image = { image: "registry.example/kernel:1", digest: `sha256:${"a".repeat(64)}` };
const limits = {
  schema: "limits@1",
  date: DATE,
  images: { kernel: image, supervisor: { "claude-code": image }, builder: { "claude-code": image }, verifier: { "claude-code": image, codex: image } },
  harnesses: { "claude-code": { command: ["claude", "-p"], families: ["anthropic"] }, codex: { command: ["codex", "exec"], families: ["openai"] } },
  ladders: { anthropic: { climb: [{ model: "claude-haiku-5-5", effort: "medium" }], top: { model: "claude-fable-5-1", effort: "xhigh" } } },
  panelProfiles: { code: [{ role: "code-quality", model: "gpt-6-sol", effort: "high" }, { role: "architect", model: "gpt-6-astra", effort: "high" }] },
  egress: { kernel: { allow: [{ capability: "ledger-remote" }] }, supervisor: {}, builder: {}, verifier: {} },
  budget: { perGoal: 3600, perProgram: 36000, unit: "seconds" },
  wallClock: { builderSeconds: 1800, verifierSeconds: 900, idleSeconds: 300 },
  tree: { depth: 2, width: 6 },
  parallelGoals: 1,
  acceptsSupervisorGoals: false,
  maxSplitGoals: 8,
  maxSplits: 1,
  supervisor: { harness: "claude-code", model: "claude-opus-5-5", effort: "medium" },
  stagnationRepeats: 2,
  kit: { commit: "0".repeat(40) },
};
const decision = { schema: "budget-decision@1", date: DATE, request: `${RUN}/requests/1.json`, outcome: "approved", ceiling: 7200, reason: "The goal is nearly done." };
const vouch = {
  schema: "vouch@1",
  date: DATE,
  round: `${RUN}/goals/pr1/rounds/a1-r1.json`,
  seat: "security",
  cause: "no Apple runtime in the sandbox",
  evidence: "projects/alpha/contracts/pr1/evidence/demo.md",
  blob: "b".repeat(40),
  reason: "The committed demo repeats the probe the seat could not run.",
};
const seat = { role: "architect", model: "gpt-6-astra", effort: "high" };
const ROUND = `${RUN}/goals/pr1/rounds/a1-r1.json`;
const ATTEMPT = `${RUN}/goals/pr1/attempts/a1.json`;
const ATTESTATION = `${RUN}/goals/pr1/attestation.json`;
const finding = { severity: "medium", detail: "The write accepts the operator's kinds.", remediation: "List the kinds by writer and refuse the operator's." };
const round = {
  schema: "round@1",
  date: DATE,
  attempt: ATTEMPT,
  commit: SHA,
  profile: "code",
  seats: [
    { ...seat, vote: "pass", confidence: 0.9, findings: [] },
    { role: "code-quality", model: "gpt-6-sol", effort: "high", vote: "fail", confidence: 0.6, findings: [finding] },
    { role: "security", model: "gpt-6-sol", effort: "xhigh", vote: "inconclusive", confidence: 0, findings: [], cause: "the classifier refused the probe" },
  ],
  passed: false,
};
/** One valid record of each kind the kernel writes, by its path in the run. */
const kernelRecords: Readonly<Record<string, Readonly<Record<string, unknown>>>> = {
  [ATTEMPT]: {
    schema: "attempt@1",
    date: DATE,
    goal: CONTRACT,
    difficulty: 0,
    rung: { model: "claude-haiku-5-5", effort: "medium", harness: "claude-code", image },
    seed: SHA,
    limits: `${RUN}/limits/1.json`,
    builder: "kernel-first-pr1-a1-builder",
  },
  [ROUND]: round,
  [`${RUN}/goals/pr1/grants/1.json`]: { schema: "budget-grant@1", date: DATE, goal: CONTRACT, amount: 600, reason: "The suite is slow.", remaining: 3000 },
  [`${RUN}/requests/1.json`]: { schema: "budget-request@1", date: DATE, goal: CONTRACT, amount: 7200, reason: "The images need a rebuild.", spent: 3600 },
  [ATTESTATION]: { schema: "attestation@1", date: DATE, round: ROUND, commit: SHA, seats: [seat], vouches: [`${RUN}/vouches/1.json`] },
  [`${RUN}/goals/pr1/landing.json`]: { schema: "landing@1", date: DATE, attestation: ATTESTATION, commit: SHA, branch: "runs/first", pullRequest: "example/alpha#12" },
  [`${RUN}/goals/pr1/state.json`]: { schema: "goal-state@1", date: DATE, goal: CONTRACT, phase: "judging", attempt: ATTEMPT, round: ROUND },
  [`${RUN}/halt.json`]: { schema: "halt@1", date: DATE, cause: "operator-stop", goals: [CONTRACT] },
};

test("a run holding a limits record and a budget decision validates, and an unknown version of either kind is refused", () => {
  const root = ledgerWithRun();
  writeJson(join(root, RUN, "limits/1.json"), limits);
  writeJson(join(root, RUN, "decisions/1.json"), decision);
  writeJson(join(root, RUN, "decisions/2.json"), { ...decision, outcome: "denied", ceiling: 3600, reason: "Not this week; the ceiling stands." });
  expect(ledger(["validate"], root)).toMatchObject({ code: 0, stdout: "the ledger is valid\n" });

  writeJson(join(root, RUN, "limits/2.json"), { ...limits, schema: "limits@2" });
  writeJson(join(root, RUN, "decisions/3.json"), { ...decision, schema: "budget-decision@7" });
  expect(problems(ledger(["validate"], root))).toStrictEqual([
    `${RUN}/decisions/3.json: schema: budget-decision@7 is not a version the ledger accepts`,
    `${RUN}/limits/2.json: schema: limits@2 is not a version the ledger accepts`,
  ]);
});

test("the limits schema refuses an effort above xhigh, more than one parallel goal, a unit other than seconds, a bound below one, and a malformed kit commit, each at its field", () => {
  const root = ledgerWithRun();
  writeJson(join(root, RUN, "limits/1.json"), {
    ...limits,
    ladders: { anthropic: { climb: [{ model: "claude-haiku-5-5", effort: "max" }], top: { model: "claude-fable-5-1", effort: "high" } } },
    panelProfiles: { code: [{ role: "architect", model: "gpt-6-astra", effort: "max" }] },
    parallelGoals: 2,
    budget: { ...limits.budget, unit: "tokens" },
    wallClock: { ...limits.wallClock, idleSeconds: 0 },
    tree: { depth: 0, width: 1 },
    kit: { commit: "abc" },
    acceptsSupervisorGoals: "yes",
    maxSplits: -1,
    maxDifficulty: -1,
  });
  expect(problems(ledger(["validate"], root))).toStrictEqual([
    `${RUN}/limits/1.json: acceptsSupervisorGoals: must be true or false`,
    `${RUN}/limits/1.json: budget.unit: must be "seconds"`,
    `${RUN}/limits/1.json: kit.commit: is not in the required form`,
    `${RUN}/limits/1.json: ladders.anthropic.climb[0].effort: must be one of "low", "medium", "high", "xhigh"`,
    `${RUN}/limits/1.json: ladders.anthropic.top.effort: must be "xhigh"`,
    `${RUN}/limits/1.json: maxDifficulty: must be at least 0`,
    `${RUN}/limits/1.json: maxSplits: must be at least 0`,
    `${RUN}/limits/1.json: panelProfiles.code[0].effort: must be one of "low", "medium", "high", "xhigh"`,
    `${RUN}/limits/1.json: parallelGoals: must be 1`,
    `${RUN}/limits/1.json: tree.depth: must be at least 1`,
    `${RUN}/limits/1.json: wallClock.idleSeconds: must be at least 1`,
  ]);
});

test("the limits schema accepts a record that omits every field with a default, a ladder that is only its top rung, and zero as the split and difficulty caps", () => {
  const root = ledgerWithRun();
  const minimal: Record<string, unknown> = { ...limits, maxSplits: 0, maxDifficulty: 0, ladders: { anthropic: { climb: [], top: limits.ladders.anthropic.top } } };
  for (const field of ["parallelGoals", "acceptsSupervisorGoals", "maxSplitGoals", "stagnationRepeats"]) delete minimal[field];
  writeJson(join(root, RUN, "limits/1.json"), minimal);
  expect(ledger(["validate"], root)).toMatchObject({ code: 0, stdout: "the ledger is valid\n" });
});

test("the limits schema requires every field without a default, and refuses an image without a digest and a field it does not know", () => {
  const root = ledgerWithRun();
  const partial: Record<string, unknown> = { ...limits, images: { ...limits.images, kernel: { image: "registry.example/kernel:1" } }, extra: true };
  delete partial.ladders;
  delete partial.kit;
  writeJson(join(root, RUN, "limits/1.json"), partial);
  expect(problems(ledger(["validate"], root))).toStrictEqual([
    `${RUN}/limits/1.json: extra: is not a field of this record`,
    `${RUN}/limits/1.json: images.kernel.digest: is required`,
    `${RUN}/limits/1.json: kit: is required`,
    `${RUN}/limits/1.json: ladders: is required`,
  ]);
});

test("the budget-decision schema refuses an outcome it does not know, a ceiling below one, an empty reason, and a decision without its ceiling", () => {
  const root = ledgerWithRun();
  writeJson(join(root, RUN, "decisions/1.json"), { ...decision, outcome: "maybe", ceiling: 0, reason: "" });
  const { ceiling, ...withoutCeiling } = decision;
  writeJson(join(root, RUN, "decisions/2.json"), withoutCeiling);
  expect(ceiling).toBe(7200);
  expect(problems(ledger(["validate"], root))).toStrictEqual([
    `${RUN}/decisions/1.json: ceiling: must be at least 1`,
    `${RUN}/decisions/1.json: outcome: must be one of "approved", "denied"`,
    `${RUN}/decisions/1.json: reason: must not be empty`,
    `${RUN}/decisions/2.json: ceiling: is required`,
  ]);
});

test("a field naming a record or a file by path refuses a path that leaves the ledger, is empty, or starts from the root", () => {
  const root = ledgerWithRun();
  writeJson(join(root, RUN, "decisions/1.json"), { ...decision, request: "../../outside" });
  writeJson(join(root, RUN, "decisions/2.json"), { ...decision, request: "" });
  writeJson(join(root, RUN, "vouches/1.json"), { ...vouch, round: `/${RUN}/goals/pr1/rounds/a1-r1.json`, evidence: "projects/alpha/contracts/pr1/evidence/./demo.md" });
  expect(problems(ledger(["validate"], root))).toStrictEqual([
    `${RUN}/decisions/1.json: request: is not in the required form`,
    `${RUN}/decisions/2.json: request: is not in the required form`,
    `${RUN}/vouches/1.json: evidence: is not in the required form`,
    `${RUN}/vouches/1.json: round: is not in the required form`,
  ]);
});

test("links on a record inside a run are checked even when the run's own record is unreadable", () => {
  const root = ledgerWithRun();
  writeFileSync(join(root, RUN, "run.json"), "{ not json");
  writeJson(join(root, RUN, "vouches/1.json"), { ...vouch, links: ["projects/ghost"] });
  expect(problems(ledger(["validate"], root))).toStrictEqual([`${RUN}/run.json: is not JSON`, `${RUN}/vouches/1.json: links: no record at projects/ghost`]);
});

test("a record inside a run may carry links, each checked for existence as a document's are", () => {
  const root = ledgerWithRun();
  writeJson(join(root, RUN, "vouches/1.json"), { ...vouch, links: ["projects/alpha/contracts/pr1", RUN] });
  writeJson(join(root, RUN, "decisions/1.json"), { ...decision, links: [`${RUN}/vouches/1.json`] });
  expect(ledger(["validate"], root)).toMatchObject({ code: 0, stdout: "the ledger is valid\n" });

  writeJson(join(root, RUN, "vouches/1.json"), { ...vouch, links: ["projects/ghost", `${RUN}/vouches/2.json`] });
  expect(problems(ledger(["validate"], root))).toStrictEqual([
    `${RUN}/vouches/1.json: links: no record at ${RUN}/vouches/2.json`,
    `${RUN}/vouches/1.json: links: no record at projects/ghost`,
  ]);
});

test("a run holding one record of each kind the kernel writes validates, and such a record is refused anywhere but in a run", () => {
  const root = ledgerWithRun();
  for (const [path, record] of Object.entries(kernelRecords)) writeJson(join(root, path), record);
  expect(ledger(["validate"], root)).toMatchObject({ code: 0, stdout: "the ledger is valid\n" });

  writeJson(join(root, "projects/alpha/attempt.json"), kernelRecords[ATTEMPT]);
  writeJson(join(root, CONTRACT, "state.json"), kernelRecords[`${RUN}/goals/pr1/state.json`]);
  writeJson(join(root, "programs/group/round.json"), round);
  expect(problems(ledger(["validate"], root))).toStrictEqual([
    "programs/group/round.json: does not belong in a program",
    "projects/alpha/attempt.json: does not belong in a project",
    `${CONTRACT}/state.json: does not belong in a contract`,
  ]);
});

test("the kernel's kinds accept a goal state with nothing in progress, an attestation with no vouch, and a halt with no goal in flight", () => {
  const root = ledgerWithRun();
  writeJson(join(root, RUN, "goals/pr1/state.json"), { schema: "goal-state@1", date: DATE, goal: CONTRACT, phase: "pending" });
  writeJson(join(root, ATTESTATION), { ...kernelRecords[ATTESTATION], vouches: [] });
  writeJson(join(root, RUN, "halt.json"), { schema: "halt@1", date: DATE, cause: "stagnation", goals: [] });
  expect(ledger(["validate"], root)).toMatchObject({ code: 0, stdout: "the ledger is valid\n" });
});

test("the kernel's kinds refuse an effort above xhigh, a phase, cause, vote or severity outside their sets, a confidence outside 0 to 1, an inconclusive seat without a cause, a bound below its floor, and a malformed commit, name, pull request or path in every path field, each at its field", () => {
  const root = ledgerWithRun();
  const attempt = kernelRecords[ATTEMPT] ?? {};
  const failing = { ...seat, vote: "maybe", confidence: 1.5, findings: [{ severity: "critical", detail: "", remediation: "" }] };
  const inconclusive = { ...seat, vote: "inconclusive", confidence: -0.1, findings: [], cause: "" };
  const silent = { ...seat, vote: "inconclusive", confidence: 0.5, findings: [] };
  writeJson(join(root, ROUND), { ...round, attempt: `/${ATTEMPT}`, commit: "xyz", profile: "Code", seats: [failing, inconclusive, silent], passed: "yes" });
  writeJson(join(root, RUN, "goals/pr1/rounds/a1-r2.json"), { ...round, seats: [] });
  writeJson(join(root, ATTEMPT), { ...attempt, goal: `/${CONTRACT}`, difficulty: -1, rung: { ...(attempt.rung as object), effort: "max", harness: "Claude Code" }, seed: "abc", limits: "", builder: "X" });
  writeJson(join(root, RUN, "goals/pr1/grants/1.json"), { ...kernelRecords[`${RUN}/goals/pr1/grants/1.json`], goal: `../${CONTRACT}`, amount: 0, reason: "", remaining: -1 });
  writeJson(join(root, RUN, "requests/1.json"), { ...kernelRecords[`${RUN}/requests/1.json`], goal: "", spent: -1 });
  writeJson(join(root, ATTESTATION), { ...kernelRecords[ATTESTATION], round: `/${ROUND}`, commit: "xyz", seats: [], vouches: ["../../out"] });
  writeJson(join(root, RUN, "goals/pr1/landing.json"), { ...kernelRecords[`${RUN}/goals/pr1/landing.json`], attestation: `./${ATTESTATION}`, commit: "xyz", branch: "", pullRequest: "example/alpha" });
  writeJson(join(root, RUN, "goals/pr1/state.json"), { ...kernelRecords[`${RUN}/goals/pr1/state.json`], goal: "projects//alpha", phase: "flying", cause: "tired", attempt: `${ATTEMPT}/`, round: ".." });
  writeJson(join(root, RUN, "halt.json"), { ...kernelRecords[`${RUN}/halt.json`], cause: "lunch", goals: ["/x"] });
  const malformed = "is not in the required form";
  expect(problems(ledger(["validate"], root))).toStrictEqual([
    `${ATTEMPT}: builder: ${malformed}`,
    `${ATTEMPT}: difficulty: must be at least 0`,
    `${ATTEMPT}: goal: ${malformed}`,
    `${ATTEMPT}: limits: ${malformed}`,
    `${ATTEMPT}: rung.effort: must be one of "low", "medium", "high", "xhigh"`,
    `${ATTEMPT}: rung.harness: ${malformed}`,
    `${ATTEMPT}: seed: ${malformed}`,
    `${ATTESTATION}: commit: ${malformed}`,
    `${ATTESTATION}: round: ${malformed}`,
    `${ATTESTATION}: seats: must have at least 1 item`,
    `${ATTESTATION}: vouches[0]: ${malformed}`,
    `${RUN}/goals/pr1/grants/1.json: amount: must be at least 1`,
    `${RUN}/goals/pr1/grants/1.json: goal: ${malformed}`,
    `${RUN}/goals/pr1/grants/1.json: reason: must not be empty`,
    `${RUN}/goals/pr1/grants/1.json: remaining: must be at least 0`,
    `${RUN}/goals/pr1/landing.json: attestation: ${malformed}`,
    `${RUN}/goals/pr1/landing.json: branch: must not be empty`,
    `${RUN}/goals/pr1/landing.json: commit: ${malformed}`,
    `${RUN}/goals/pr1/landing.json: pullRequest: ${malformed}`,
    `${ROUND}: attempt: ${malformed}`,
    `${ROUND}: commit: ${malformed}`,
    `${ROUND}: passed: must be true or false`,
    `${ROUND}: profile: ${malformed}`,
    `${ROUND}: seats[0].confidence: must be at most 1`,
    `${ROUND}: seats[0].findings[0].detail: must not be empty`,
    `${ROUND}: seats[0].findings[0].remediation: must not be empty`,
    `${ROUND}: seats[0].findings[0].severity: must be one of "low", "medium", "high"`,
    `${ROUND}: seats[0].vote: must be one of "pass", "fail", "inconclusive"`,
    `${ROUND}: seats[1].cause: must not be empty`,
    `${ROUND}: seats[1].confidence: must be at least 0`,
    `${ROUND}: seats[2].cause: is required`,
    `${RUN}/goals/pr1/rounds/a1-r2.json: seats: must have at least 1 item`,
    `${RUN}/goals/pr1/state.json: attempt: ${malformed}`,
    `${RUN}/goals/pr1/state.json: cause: must be one of "refused", "lost", "deadline", "idle", "budget", "unstaged", "not-one-commit", "check-failed", "read-back-mismatch", "no-structured-vote", "panel-failed", "stagnation", "budget-denied", "stopped"`,
    `${RUN}/goals/pr1/state.json: goal: ${malformed}`,
    `${RUN}/goals/pr1/state.json: phase: must be one of "pending", "blocked", "building", "collecting", "judging", "failed-round", "deciding", "passed", "landing", "delivered", "merged", "failed", "dropped"`,
    `${RUN}/goals/pr1/state.json: round: ${malformed}`,
    `${RUN}/halt.json: cause: must be one of "stagnation", "operator-stop", "budget-denied", "supervisor-stop"`,
    `${RUN}/halt.json: goals[0]: ${malformed}`,
    `${RUN}/requests/1.json: goal: ${malformed}`,
    `${RUN}/requests/1.json: spent: must be at least 0`,
  ]);
});
