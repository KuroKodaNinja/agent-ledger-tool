import { expect, test } from "bun:test";
import { chmodSync, readdirSync, readFileSync, renameSync, symlinkSync } from "node:fs";
import { join } from "node:path";
import { emptyLedger, ledger, withoutSuperuser, writeJson } from "./support.ts";

const readJson = (file: string): unknown => JSON.parse(readFileSync(file, "utf8"));

test("new projects and a program spanning them are written as valid records that list each other", () => {
  const root = emptyLedger();
  expect(ledger(["new", "project", "alpha", "--title", "Alpha", "--summary", "Sandboxes", "--repository", "owner/alpha"], root)).toStrictEqual({ code: 0, stdout: "created projects/alpha\n", stderr: "" });
  expect(ledger(["new", "project", "beta", "--title", "beta", "--summary", "A kit"], root).code).toBe(0);
  expect(ledger(["new", "program", "group", "--title", "Group", "--summary", "Split", "--projects", "alpha,beta"], root)).toMatchObject({ code: 0, stdout: "created programs/group\n" });
  expect(readJson(join(root, "projects/alpha/project.json"))).toStrictEqual({
    schema: "project@1", name: "alpha", title: "Alpha", status: "active", summary: "Sandboxes", repository: "owner/alpha", programs: ["group"],
  });
  expect(readJson(join(root, "programs/group/program.json"))).toStrictEqual({
    schema: "program@1", name: "group", title: "Group", status: "active", summary: "Split", projects: ["alpha", "beta"],
  });
  expect(ledger(["validate"], root)).toMatchObject({ code: 0, stdout: "the ledger is valid\n" });
});

test("a name already taken is refused, and the ledger is left as it was", () => {
  const root = emptyLedger();
  ledger(["new", "project", "alpha", "--title", "Alpha", "--summary", "first"], root);
  ledger(["new", "program", "group", "--title", "Group", "--summary", "first", "--projects", "alpha"], root);
  const before = readFileSync(join(root, "projects/alpha/project.json"), "utf8");
  expect(ledger(["new", "project", "alpha", "--title", "Again", "--summary", "second"], root)).toStrictEqual({ code: 1, stdout: "", stderr: "error: projects/alpha already exists\n" });
  expect(ledger(["new", "program", "group", "--title", "Again", "--summary", "second", "--projects", "alpha"], root)).toMatchObject({ code: 1, stderr: "error: programs/group already exists\n" });
  expect(readFileSync(join(root, "projects/alpha/project.json"), "utf8")).toBe(before);
});

test("a program over a project that does not exist, or in a ledger that is not valid, is refused before anything is written", () => {
  const root = emptyLedger();
  ledger(["new", "project", "alpha", "--title", "Alpha", "--summary", "fine"], root);
  expect(ledger(["new", "program", "group", "--title", "G", "--summary", "s", "--projects", "alpha,ghost"], root)).toMatchObject({ code: 1, stderr: "error: no project named ghost\n" });
  writeJson(join(root, "projects/broken/project.json"), { schema: "project@1", name: "broken" });
  expect(ledger(["new", "program", "group", "--title", "G", "--summary", "s", "--projects", "alpha,broken"], root)).toMatchObject({ code: 1, stderr: "error: the ledger is not valid; run ledger validate\n" });
  expect(readdirSync(root).includes("programs")).toBe(false);
  expect(readJson(join(root, "projects/alpha/project.json"))).toMatchObject({ programs: [] });
});

test("arguments the schemas refuse, and missing ones, are usage errors that write nothing", () => {
  const root = emptyLedger();
  const cases: readonly (readonly [readonly string[], string])[] = [
    [["new", "project", "Bad_Name", "--title", "t", "--summary", "s"], 'error: project name "Bad_Name": use lowercase letters, digits, and hyphens, starting with a letter or digit'],
    [["new", "project", "alpha", "--title", "t", "--summary", "s", "--repository", "no-slash"], "error: repository: is not in the required form"],
    [["new", "project", "alpha", "--summary", "s"], "error: --title is required"],
    [["new", "project", "--title", "t", "--summary", "s"], "error: a name is required"],
    [["new", "program", "group", "--title", "t", "--summary", "s"], "error: --projects is required"],
    [["new", "program", "group", "--title", "t", "--summary", "s", "--projects", ","], "error: projects: must have at least 1 item"],
    [["validate", "--title", "t"], "error: validate takes no --title"],
    [["new", "project", "alpha", "--title", "t", "--summary", "s", "--projects", "x"], "error: new project takes no --projects"],
    [["new", "program", "group", "--title", "t", "--summary", "s", "--projects", "x", "--repository", "o/r"], "error: new program takes no --repository"],
  ];
  for (const [args, message] of cases) {
    const run = ledger(args, root);
    expect(run.code).toBe(2);
    expect(run.stderr.split("\n")[0]).toBe(message);
  }
  expect(readdirSync(root)).toStrictEqual(["ledger.json"]);
});

// Every file under `dir`, by path, with its contents.
function snapshot(dir: string): Readonly<Record<string, string>> {
  const files = readdirSync(dir, { recursive: true, withFileTypes: true }).filter((entry) => entry.isFile());
  return Object.fromEntries(files.map((entry) => [join(entry.parentPath, entry.name), readFileSync(join(entry.parentPath, entry.name), "utf8")]));
}

test("the commands change only a valid ledger, so a project named unlike its directory, or behind a link, is never written", () => {
  const renamed = emptyLedger();
  ledger(["new", "project", "alpha", "--title", "Alpha", "--summary", "s"], renamed);
  renameSync(join(renamed, "projects/alpha"), join(renamed, "projects/beta"));
  const before = snapshot(renamed);
  const refused = { code: 1, stdout: "", stderr: "error: the ledger is not valid; run ledger validate\n" };
  expect(ledger(["new", "program", "group", "--title", "G", "--summary", "s", "--projects", "beta"], renamed)).toStrictEqual(refused);
  expect(ledger(["new", "project", "gamma", "--title", "G", "--summary", "s"], renamed)).toStrictEqual(refused);
  expect(snapshot(renamed)).toStrictEqual(before);

  const outside = emptyLedger();
  writeJson(join(outside, "alpha/project.json"), { schema: "project@1", name: "alpha", title: "A", status: "active", summary: "s", programs: [] });
  const outsideBefore = snapshot(outside);
  const linked = emptyLedger();
  ledger(["new", "project", "beta", "--title", "Beta", "--summary", "s"], linked);
  symlinkSync(join(outside, "alpha"), join(linked, "projects/alpha"));
  expect(ledger(["new", "program", "group", "--title", "G", "--summary", "s", "--projects", "alpha,beta"], linked)).toStrictEqual(refused);
  expect(snapshot(outside)).toStrictEqual(outsideBefore);
  expect(readdirSync(linked).includes("programs")).toBe(false);
});

withoutSuperuser("a write that fails undoes the writes before it and is reported as an error (skipped as a superuser)", () => {
  const root = emptyLedger();
  ledger(["new", "project", "alpha", "--title", "Alpha", "--summary", "s"], root);
  ledger(["new", "project", "beta", "--title", "Beta", "--summary", "s"], root);
  chmodSync(join(root, "projects/beta/project.json"), 0o444);
  const before = snapshot(root);
  expect(ledger(["new", "program", "group", "--title", "G", "--summary", "s", "--projects", "alpha,beta"], root)).toStrictEqual({
    code: 1,
    stdout: "",
    stderr: "error: cannot write projects/beta/project.json\n",
  });
  expect(snapshot(root)).toStrictEqual(before);
  expect(readdirSync(root).includes("programs")).toBe(false);

  chmodSync(join(root, "projects"), 0o555);
  expect(ledger(["new", "project", "gamma", "--title", "G", "--summary", "s"], root)).toStrictEqual({
    code: 1,
    stdout: "",
    stderr: "error: cannot write projects/gamma/project.json\n",
  });
  chmodSync(join(root, "projects"), 0o755);
  expect(snapshot(root)).toStrictEqual(before);
});
