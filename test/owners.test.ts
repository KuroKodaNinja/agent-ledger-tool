import { expect, test } from "bun:test";
import { mkdirSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { emptyLedger, ledger, problems, writeJson } from "./support.ts";

const project = (name: string, programs: readonly string[] = []) => ({
  schema: "project@1",
  name,
  title: name,
  status: "active",
  summary: "a project",
  programs,
});
const program = (name: string, projects: readonly string[]) => ({
  schema: "program@1",
  name,
  title: name,
  status: "active",
  summary: "a program",
  projects,
});

test("projects and programs that list each other are valid, beside a README", () => {
  const root = emptyLedger();
  writeJson(join(root, "projects/alpha/project.json"), project("alpha", ["both"]));
  writeJson(join(root, "projects/beta/project.json"), { ...project("beta", ["both"]), repository: "owner/beta" });
  writeJson(join(root, "programs/both/program.json"), program("both", ["alpha", "beta"]));
  writeFileSync(join(root, "projects/README.md"), "# Projects\n");
  writeFileSync(join(root, "programs/README.md"), "# Programs\n");
  expect(ledger(["validate"], join(root, "projects/alpha"))).toStrictEqual({ code: 0, stdout: "the ledger is valid\n", stderr: "" });
});

test("every problem in a manifest, and everything that does not belong, is reported at once", () => {
  const root = emptyLedger();
  writeJson(join(root, "projects/alpha/project.json"), { ...project("other"), status: "dormant", extra: true, summary: "" });
  writeJson(join(root, "projects/beta/project.json"), { ...project("beta"), schema: "program@1" });
  writeJson(join(root, "projects/gamma/project.json"), { ...project("gamma"), schema: "project@2" });
  writeJson(join(root, "projects/delta/project.json"), { ...project("delta"), repository: "not a repository", programs: ["x", "x"] });
  writeFileSync(join(root, "projects/epsilon.json"), "{}");
  mkdirSync(join(root, "projects/Upper"));
  mkdirSync(join(root, "projects/empty"));
  mkdirSync(join(root, "projects/broken"));
  writeFileSync(join(root, "projects/broken/project.json"), "{ not json");
  writeJson(join(root, "projects/zeta/project.json"), project("zeta"));
  writeFileSync(join(root, "projects/zeta/notes.txt"), "stray");
  const run = ledger(["validate"], root);
  expect(run.code).toBe(1);
  const notHere = "does not belong here: projects/ holds only project directories, named in lowercase letters, digits, and hyphens";
  expect(problems(run)).toStrictEqual([
    "projects/alpha/project.json: extra: is not a field of this record",
    'projects/alpha/project.json: name: must be "alpha", the directory\'s name',
    'projects/alpha/project.json: status: must be one of "active", "paused", "archived"',
    "projects/alpha/project.json: summary: must not be empty",
    "projects/beta/project.json: schema: is a program record where a project belongs",
    "projects/broken/project.json: is not JSON",
    "projects/delta/project.json: programs: must not repeat an item",
    "projects/delta/project.json: programs: no program named x",
    "projects/delta/project.json: repository: is not in the required form",
    "projects/empty/project.json: is missing",
    `projects/epsilon.json: ${notHere}`,
    "projects/gamma/project.json: schema: project@2 is not a version the ledger accepts",
    `projects/Upper: ${notHere}`,
    "projects/zeta/notes.txt: does not belong in a project",
  ]);
});

test("a project and a program that do not list each other are each reported", () => {
  const root = emptyLedger();
  writeJson(join(root, "projects/alpha/project.json"), project("alpha", ["missing", "lopsided"]));
  writeJson(join(root, "projects/beta/project.json"), project("beta"));
  writeJson(join(root, "programs/lopsided/program.json"), program("lopsided", ["beta"]));
  writeJson(join(root, "programs/empty/program.json"), program("empty", []));
  expect(problems(ledger(["validate"], root))).toStrictEqual([
    "programs/empty/program.json: projects: must have at least 1 item",
    "programs/lopsided/program.json: projects: project beta does not list this program in its programs",
    "projects/alpha/project.json: programs: no program named missing",
    "projects/alpha/project.json: programs: program lopsided does not list this project in its projects",
  ]);
});

test("a link, a directory, or a pipe where a manifest or an owner belongs is reported, never followed", () => {
  const outside = emptyLedger();
  writeJson(join(outside, "alpha/project.json"), project("alpha"));
  writeJson(join(outside, "beta.json"), project("beta"));
  const root = emptyLedger();
  mkdirSync(join(root, "projects/beta"), { recursive: true });
  symlinkSync(join(outside, "alpha"), join(root, "projects/alpha"));
  symlinkSync(join(outside, "beta.json"), join(root, "projects/beta/project.json"));
  mkdirSync(join(root, "projects/gamma/project.json"), { recursive: true });
  mkdirSync(join(root, "projects/delta"));
  expect(Bun.spawnSync(["mkfifo", join(root, "projects/delta/project.json")]).exitCode).toBe(0);
  const notAFile = "must be a file, not a link or a directory";
  expect(problems(ledger(["validate"], root))).toStrictEqual([
    "projects/alpha: does not belong here: projects/ holds only project directories, named in lowercase letters, digits, and hyphens",
    `projects/beta/project.json: ${notAFile}`,
    `projects/delta/project.json: ${notAFile}`,
    `projects/gamma/project.json: ${notAFile}`,
  ]);

  const linked = emptyLedger();
  symlinkSync(outside, join(linked, "projects"));
  expect(problems(ledger(["validate"], linked))).toStrictEqual(["projects: must be a directory, not a link or a file"]);
});

test("a manifest with another problem still has its links checked, and links to it are not reported as leading nowhere", () => {
  const root = emptyLedger();
  writeJson(join(root, "projects/alpha/project.json"), { ...project("alpha", ["group", "missing"]), title: "" });
  writeJson(join(root, "programs/group/program.json"), program("group", ["alpha"]));
  expect(problems(ledger(["validate"], root))).toStrictEqual([
    "projects/alpha/project.json: programs: no program named missing",
    "projects/alpha/project.json: title: must not be empty",
  ]);
});
