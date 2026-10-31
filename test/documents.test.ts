import { expect, test } from "bun:test";
import { mkdirSync, readFileSync, readdirSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { emptyLedger, ledger, ledgerWithChangedSchemas, ledgerWithOwners, problems, writeDocument } from "./support.ts";

const decision = (status: string, more: Readonly<Record<string, unknown>> = {}) => ({ schema: "decision@1", title: "D", date: "2026-10-01", status, ...more });
const plan = (more: Readonly<Record<string, unknown>> = {}) => ({ schema: "plan@1", title: "P", date: "2026-10-01", status: "draft", ...more });

test("new creates every kind of document, dated, in its first status, and numbers decisions in their owner", () => {
  const root = ledgerWithOwners();
  const created = (args: readonly string[]) => ledger(["new", ...args], root);
  expect(created(["plan", "build", "--in", "projects/alpha", "--title", "Build: the order", "--date", "2026-09-19"])).toStrictEqual({ code: 0, stdout: "created projects/alpha/plans/build.md\n", stderr: "" });
  expect(created(["decision", "first", "--in", "projects/alpha", "--title", "First"]).stdout).toBe("created projects/alpha/decisions/D0001-first.md\n");
  expect(created(["decision", "second", "--in", "projects/alpha", "--title", "Second"]).stdout).toBe("created projects/alpha/decisions/D0002-second.md\n");
  expect(created(["decision", "first", "--in", "programs/group", "--title", "Elsewhere"]).stdout).toBe("created programs/group/decisions/D0001-first.md\n");
  expect(created(["contract", "pr1", "--in", "projects/alpha", "--title", "PR 1"]).stdout).toBe("created projects/alpha/contracts/pr1\n");
  expect(created(["research", "spike", "--in", "programs/group", "--title", "Spike"]).code).toBe(0);
  expect(created(["handoff", "session", "--in", "projects/alpha", "--title", "Session"]).code).toBe(0);

  expect(readFileSync(join(root, "projects/alpha/plans/build.md"), "utf8")).toBe(
    '---\nschema: "plan@1"\ntitle: "Build: the order"\ndate: "2026-09-19"\nstatus: "draft"\n---\n\n# Build: the order\n',
  );
  expect(readFileSync(join(root, "projects/alpha/decisions/D0002-second.md"), "utf8")).toMatch(/^---\nschema: "decision@1"\ntitle: "Second"\ndate: "\d{4}-\d{2}-\d{2}"\nstatus: "proposed"\n---\n/);
  expect(readFileSync(join(root, "projects/alpha/contracts/pr1/contract.md"), "utf8")).toContain('status: "open"');
  expect(readFileSync(join(root, "programs/group/research/spike.md"), "utf8")).not.toContain("status");
  expect(ledger(["validate"], root)).toMatchObject({ code: 0, stdout: "the ledger is valid\n" });
});

test("new refuses an owner, a name, or a date it cannot use, and writes nothing", () => {
  const root = ledgerWithOwners();
  ledger(["new", "plan", "build", "--in", "projects/alpha", "--title", "Build"], root);
  ledger(["new", "decision", "first", "--in", "projects/alpha", "--title", "First"], root);
  const refusals: readonly (readonly [readonly string[], number, string])[] = [
    [["plan", "build", "--in", "projects/alpha", "--title", "Again"], 1, "error: projects/alpha/plans/build.md already exists\n"],
    [["decision", "first", "--in", "projects/alpha", "--title", "Again"], 1, "error: projects/alpha/decisions/D0001-first.md already exists\n"],
    [["plan", "x", "--in", "projects/ghost", "--title", "X"], 1, "error: no project or program at projects/ghost\n"],
    [["plan", "x", "--in", "projects/alpha/plans", "--title", "X"], 1, "error: no project or program at projects/alpha/plans\n"],
    [["plan", "Bad_Name", "--in", "projects/alpha", "--title", "X"], 2, 'error: plan name "Bad_Name": use lowercase letters, digits, and hyphens, starting with a letter or digit\n'],
    [["plan", "x", "--in", "projects/alpha", "--title", "X", "--date", "1 Oct"], 2, "error: date: is not in the required form\n"],
    [["plan", "x", "--title", "X"], 2, "error: --in is required\n"],
  ];
  for (const [args, code, stderr] of refusals) {
    const run = ledger(["new", ...args], root);
    expect(run.code).toBe(code);
    expect(`${run.stderr.split("\n")[0]}\n`).toBe(stderr);
  }
  expect(readdirSync(join(root, "projects/alpha/plans"))).toStrictEqual(["build.md"]);
  expect(readdirSync(join(root, "projects/alpha/decisions"))).toStrictEqual(["D0001-first.md"]);

  writeFileSync(join(root, "projects/alpha/plans/notes.txt"), "stray");
  expect(ledger(["new", "plan", "x", "--in", "projects/alpha", "--title", "X"], root)).toMatchObject({ code: 1, stderr: "error: the ledger is not valid; run ledger validate\n" });
  expect(readdirSync(join(root, "projects/alpha/plans")).sort()).toStrictEqual(["build.md", "notes.txt"]);
});

test("a document where its kind does not belong, without frontmatter, or with frontmatter its schema refuses is reported", () => {
  const root = ledgerWithOwners();
  writeDocument(root, "projects/alpha/plans/wrong-kind.md", decision("accepted"));
  writeFileSync(join(root, "projects/alpha/plans/bare.md"), "# No frontmatter\n");
  writeFileSync(join(root, "projects/alpha/plans/broken.md"), "---\nkey: [unclosed\n---\n");
  writeDocument(root, "projects/alpha/plans/fields.md", { schema: "plan@1", title: "", date: "Oct 1", status: "begun", extra: 1 });
  writeDocument(root, "projects/alpha/plans/Upper.md", plan());
  writeFileSync(join(root, "projects/alpha/plans/notes.txt"), "stray");
  mkdirSync(join(root, "projects/alpha/plans/folder.md"));
  writeDocument(root, "projects/alpha/decisions/D12-short.md", decision("accepted"));
  writeDocument(root, "projects/alpha/decisions/first.md", decision("accepted"));
  mkdirSync(join(root, "projects/alpha/contracts/empty"), { recursive: true });
  writeDocument(root, "projects/alpha/contracts/full/contract.md", { schema: "contract@1", title: "C", date: "2026-10-01", status: "open", pullRequest: "owner/repo#12" });
  writeFileSync(join(root, "projects/alpha/contracts/full/notes.md"), "stray");
  writeFileSync(join(root, "projects/alpha/contracts/loose.md"), "stray");
  mkdirSync(join(root, "projects/alpha/contracts/full/evidence/round-1"), { recursive: true });
  writeFileSync(join(root, "projects/alpha/contracts/full/evidence/round-1/log.txt"), "anything at all");
  writeDocument(root, "projects/alpha/contracts/bad-evidence/contract.md", { schema: "contract@1", title: "C", date: "2026-10-01", status: "open", pullRequest: "#12" });
  writeFileSync(join(root, "projects/alpha/contracts/bad-evidence/evidence"), "a file");
  writeDocument(root, "projects/alpha/outside.md", plan());
  symlinkSync(join(root, "projects/alpha/outside.md"), join(root, "projects/alpha/plans/linked.md"));
  writeFileSync(join(root, "programs/group/handoffs"), "a file");
  mkdirSync(join(root, "programs/group/notes"));

  const holdsOnly = (folder: string, shape: string) => `does not belong here: ${folder}/ holds only ${shape}, named in lowercase letters, digits, and hyphens`;
  expect(problems(ledger(["validate"], root))).toStrictEqual([
    "programs/group/handoffs: must be a directory, not a link or a file",
    "programs/group/notes: does not belong in a program",
    'projects/alpha/contracts/bad-evidence/contract.md: pullRequest: is not in the required form',
    "projects/alpha/contracts/bad-evidence/evidence: does not belong in a contract",
    "projects/alpha/contracts/empty/contract.md: is missing",
    "projects/alpha/contracts/full/notes.md: does not belong in a contract",
    `projects/alpha/contracts/loose.md: ${holdsOnly("contracts", "<name> directories")}`,
    `projects/alpha/decisions/D12-short.md: ${holdsOnly("decisions", "D<number>-<name>.md files")}`,
    `projects/alpha/decisions/first.md: ${holdsOnly("decisions", "D<number>-<name>.md files")}`,
    "projects/alpha/outside.md: does not belong in a project",
    "projects/alpha/plans/bare.md: must begin with YAML frontmatter between --- lines",
    "projects/alpha/plans/broken.md: frontmatter: is not YAML",
    "projects/alpha/plans/fields.md: date: is not in the required form",
    "projects/alpha/plans/fields.md: extra: is not a field of this record",
    'projects/alpha/plans/fields.md: status: must be one of "draft", "active", "done", "dropped"',
    "projects/alpha/plans/fields.md: title: must not be empty",
    `projects/alpha/plans/folder.md: ${holdsOnly("plans", "<name>.md files")}`,
    "projects/alpha/plans/linked.md: must be a file, not a link or a directory",
    `projects/alpha/plans/notes.txt: ${holdsOnly("plans", "<name>.md files")}`,
    `projects/alpha/plans/Upper.md: ${holdsOnly("plans", "<name>.md files")}`,
    "projects/alpha/plans/wrong-kind.md: schema: is a decision record where a plan belongs",
  ]);
});

test("decision numbers are unique in their owner, and a decision and what supersedes it list each other", () => {
  const root = ledgerWithOwners();
  writeDocument(root, "projects/alpha/decisions/D0001-old.md", decision("superseded", { supersededBy: ["D0002"] }));
  writeDocument(root, "projects/alpha/decisions/D0002-new.md", decision("accepted", { supersedes: ["D0001"] }));
  writeDocument(root, "programs/group/decisions/D0001-same-number-elsewhere.md", decision("accepted"));
  expect(ledger(["validate"], root)).toMatchObject({ code: 0, stdout: "the ledger is valid\n" });

  writeDocument(root, "projects/alpha/decisions/D0002-twin.md", decision("accepted"));
  writeDocument(root, "projects/alpha/decisions/D0003-one-sided.md", decision("accepted", { supersedes: ["D0009", "D0001"] }));
  writeDocument(root, "projects/alpha/decisions/D0004-claims.md", decision("superseded"));
  writeDocument(root, "projects/alpha/decisions/D0005-replaced.md", decision("accepted", { supersededBy: ["D0003"] }));
  expect(problems(ledger(["validate"], root))).toStrictEqual([
    "projects/alpha/decisions/D0002-new.md: its number is also that of projects/alpha/decisions/D0002-twin.md",
    "projects/alpha/decisions/D0002-twin.md: its number is also that of projects/alpha/decisions/D0002-new.md",
    "projects/alpha/decisions/D0003-one-sided.md: supersedes: D0001 does not list this decision in its supersededBy",
    "projects/alpha/decisions/D0003-one-sided.md: supersedes: no decision D0009",
    "projects/alpha/decisions/D0004-claims.md: status: is superseded, so supersededBy must name what replaces it",
    "projects/alpha/decisions/D0005-replaced.md: status: must be superseded, as supersededBy names what replaces it",
    "projects/alpha/decisions/D0005-replaced.md: supersededBy: D0003 does not list this decision in its supersedes",
  ]);
});

test("a document's links name projects, programs, and documents that exist", () => {
  const root = ledgerWithOwners();
  ledger(["new", "contract", "pr1", "--in", "projects/alpha", "--title", "PR 1"], root);
  ledger(["new", "decision", "first", "--in", "projects/alpha", "--title", "First"], root);
  const valid = ["projects/alpha", "programs/group", "projects/alpha/contracts/pr1", "projects/alpha/decisions/D0001-first.md"];
  writeDocument(root, "programs/group/plans/linked.md", plan({ links: valid }));
  expect(ledger(["validate"], root)).toMatchObject({ code: 0, stdout: "the ledger is valid\n" });
  writeDocument(root, "programs/group/plans/linked.md", plan({ links: [...valid, "projects/alpha/contracts/pr1/contract.md", "projects/ghost", "../outside"] }));
  expect(problems(ledger(["validate"], root))).toStrictEqual([
    "programs/group/plans/linked.md: links: no record at ../outside",
    "programs/group/plans/linked.md: links: no record at projects/alpha/contracts/pr1/contract.md",
    "programs/group/plans/linked.md: links: no record at projects/ghost",
  ]);
});

test("frontmatter that uses a YAML alias is reported, so none can loop or expand without bound", () => {
  const root = ledgerWithOwners();
  mkdirSync(join(root, "projects/alpha/plans"));
  writeFileSync(join(root, "projects/alpha/plans/loop.md"), '---\nschema: "plan@1"\ntitle: "L"\ndate: "2026-10-01"\nstatus: "draft"\nlinks: &loop [*loop]\n---\n');
  writeFileSync(join(root, "projects/alpha/plans/shared.md"), '---\nschema: "plan@1"\ntitle: "S"\ndate: "2026-10-01"\nstatus: "draft"\nlinks: &x ["projects/alpha"]\nextra: *x\n---\n');
  expect(ledger(["validate"], root)).toStrictEqual({
    code: 1,
    stdout: "projects/alpha/plans/loop.md: frontmatter: must not use YAML aliases\nprojects/alpha/plans/shared.md: frontmatter: must not use YAML aliases\n2 problems\n",
    stderr: "",
  });
});

test("a project or program whose decisions reach D9999 can take no more, and nothing is written", () => {
  const root = ledgerWithOwners();
  writeDocument(root, "projects/alpha/decisions/D9999-last.md", decision("accepted"));
  expect(ledger(["new", "decision", "more", "--in", "projects/alpha", "--title", "More"], root)).toStrictEqual({
    code: 1,
    stdout: "",
    stderr: "error: projects/alpha/decisions has no decision number left after D9999\n",
  });
  expect(readdirSync(join(root, "projects/alpha/decisions"))).toStrictEqual(["D9999-last.md"]);
});

test("new writes the newest version of a kind, starting from its schema's defaults, once an old version is retired", () => {
  const plan2 = {
    type: "object",
    required: ["schema", "title", "date", "status"],
    additionalProperties: false,
    properties: {
      schema: { const: "plan@2" },
      title: { type: "string", minLength: 1 },
      date: { $ref: "defs@1.json#/$defs/date" },
      status: { enum: ["parked", "active", "done"], default: "parked" },
    },
  };
  const root = ledgerWithChangedSchemas({ "plan@1.json": null, "plan@2.json": plan2 });
  ledger(["new", "project", "alpha", "--title", "Alpha", "--summary", "s"], root);
  expect(ledger(["new", "plan", "build", "--in", "projects/alpha", "--title", "Build", "--date", "2026-10-01"], root).code).toBe(0);
  expect(readFileSync(join(root, "projects/alpha/plans/build.md"), "utf8")).toBe(
    '---\nschema: "plan@2"\ntitle: "Build"\ndate: "2026-10-01"\nstatus: "parked"\n---\n\n# Build\n',
  );
  expect(ledger(["validate"], root)).toMatchObject({ code: 0, stdout: "the ledger is valid\n" });
  rmSync(join(root, "schema", "plan@2.json"));
  expect(ledger(["new", "plan", "x", "--in", "projects/alpha", "--title", "X"], root)).toMatchObject({
    code: 1,
    stderr: "error: the ledger accepts no plan records\n",
  });
});
