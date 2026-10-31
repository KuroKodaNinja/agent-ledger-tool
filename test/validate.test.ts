import { expect, test } from "bun:test";
import { chmodSync, mkdirSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { emptyLedger, ledger, LEDGER_MANIFEST, problems, withoutSuperuser } from "./support.ts";

test("a valid ledger passes, found from any directory inside it or named with --root", () => {
  const root = emptyLedger();
  expect(ledger(["validate"], root)).toStrictEqual({ code: 0, stdout: "the ledger is valid\n", stderr: "" });
  mkdirSync(join(root, "deep/inside"), { recursive: true });
  expect(ledger(["validate"], join(root, "deep/inside"))).toStrictEqual({ code: 0, stdout: "the ledger is valid\n", stderr: "" });
  expect(ledger(["validate", "--root", root], "/")).toStrictEqual({ code: 0, stdout: "the ledger is valid\n", stderr: "" });
});

test("every problem in the manifest is reported, one per line naming its file, and the run exits 1", () => {
  const root = emptyLedger({ schema: "ledger@1", name: "Not A Name", title: "", accepts: { project: [1] }, extra: true });
  // Which versions the ledger accepts is the schema files' to say, so an accepts list is a field like any other.
  const run = ledger(["validate"], root);
  expect(run.code).toBe(1);
  expect(problems(run)).toStrictEqual([
    "ledger.json: accepts: is not a field of this record",
    "ledger.json: extra: is not a field of this record",
    "ledger.json: name: is not in the required form",
    "ledger.json: title: must not be empty",
  ]);
  expect(run.stdout.trim().split("\n").at(-1)).toBe("4 problems");
});

test("a manifest that is missing, not JSON, not an object, or of an unknown kind or version is reported", () => {
  const cases: readonly (readonly [string | undefined, string])[] = [
    [undefined, "ledger.json: is missing"],
    ["{ not json", "ledger.json: is not JSON"],
    ["[]", "ledger.json: must be an object"],
    [JSON.stringify({ ...LEDGER_MANIFEST, schema: "ledger" }), "ledger.json: schema: must name a kind and major version, such as ledger@1"],
    [JSON.stringify({ ...LEDGER_MANIFEST, schema: "project@1" }), "ledger.json: schema: is a project record where a ledger belongs"],
    [JSON.stringify({ ...LEDGER_MANIFEST, schema: "ledger@2" }), "ledger.json: schema: ledger@2 is not a version the ledger accepts"],
  ];
  for (const [text, problem] of cases) {
    const root = emptyLedger();
    if (text === undefined) rmSync(join(root, "ledger.json"));
    else writeFileSync(join(root, "ledger.json"), text);
    const run = ledger(["validate", "--root", root], root);
    expect(run.code).toBe(1);
    expect(problems(run)).toStrictEqual([problem]);
  }
});

test("a manifest that is a directory or a link is reported, and a link is never followed", () => {
  const dir = emptyLedger();
  rmSync(join(dir, "ledger.json"));
  mkdirSync(join(dir, "ledger.json"));
  expect(problems(ledger(["validate", "--root", dir], dir))).toStrictEqual(["ledger.json: must be a file, not a link or a directory"]);
  const link = emptyLedger();
  rmSync(join(link, "ledger.json"));
  symlinkSync(join(emptyLedger(), "ledger.json"), join(link, "ledger.json"));
  expect(problems(ledger(["validate", "--root", link], link))).toStrictEqual(["ledger.json: must be a file, not a link or a directory"]);
});

withoutSuperuser("a manifest that cannot be read is a failure of the run, not a problem with the ledger (skipped as a superuser)", () => {
  const root = emptyLedger();
  chmodSync(join(root, "ledger.json"), 0o000);
  const run = ledger(["validate"], root);
  expect(run).toMatchObject({ code: 1, stdout: "" });
  expect(run.stderr).toBe("error: cannot read ledger.json\n");
});

test("a field named like an Object prototype member is refused as any unknown field is", () => {
  const root = emptyLedger();
  writeFileSync(join(root, "ledger.json"), JSON.stringify(LEDGER_MANIFEST).replace("{", '{"__proto__": {"accepts": {}}, '));
  expect(problems(ledger(["validate"], root))).toStrictEqual(["ledger.json: __proto__: is not a field of this record"]);
});

test("a field name holding control characters is printed escaped, one line per problem", () => {
  const root = emptyLedger();
  const hostile = `a${String.fromCharCode(10)}b${String.fromCharCode(27)}[31m${String.fromCharCode(0x2028)}c`;
  writeFileSync(join(root, "ledger.json"), JSON.stringify({ ...LEDGER_MANIFEST, [hostile]: 1 }));
  const run = ledger(["validate"], root);
  expect(run.stdout).toBe("ledger.json: a\\u000ab\\u001b[31m\\u2028c: is not a field of this record\n1 problem\n");
  expect([...run.stdout].some((char) => (char.codePointAt(0) ?? 0) < 0x20 && char !== "\n")).toBe(false);
});

test("outside any ledger, the tool says so and exits 1", () => {
  const outside = ledger(["validate"], "/");
  expect(outside).toMatchObject({ code: 1, stdout: "" });
  expect(outside.stderr).toBe("error: no ledger.json in / or above it\n");
});

test("arguments the tool cannot use exit 2 with the usage, and run nothing", () => {
  const root = emptyLedger();
  const cases: readonly (readonly [readonly string[], string])[] = [
    [[], "error: a command is required"],
    [["frobnicate"], 'error: unknown command "frobnicate"'],
    [["validate", "extra"], 'error: unexpected argument "extra"'],
    [["validate", "--nonsense"], "error: Unknown option '--nonsense'"],
    [["new"], 'error: new: unknown kind ""'],
    [["new", "memo", "x"], 'error: new: unknown kind "memo"'],
    [["new", "plan", "x", "y", "--in", "projects/a", "--title", "t"], 'error: unexpected argument "y"'],
    [["new", "plan", "x", "--summary", "s"], "error: new plan takes no --summary"],
  ];
  for (const [args, message] of cases) {
    const run = ledger(args, root);
    expect(run).toMatchObject({ code: 2, stdout: "" });
    expect(run.stderr.split("\n")[0]).toStartWith(message);
    expect(run.stderr).toContain("usage:\n  ledger validate\n");
  }
});
