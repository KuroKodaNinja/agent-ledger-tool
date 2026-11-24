import { expect, test } from "bun:test";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { LedgerError } from "../tools/src/errors.ts";
import { writeKernelContract } from "../tools/src/scaffold.ts";
import { ledger, ledgerWithRun } from "./support.ts";

const RUN = "projects/alpha/runs/first";
const CHILD = `${RUN}/goals/pr1-a/contract.md`;
const contract = (title = "A child of pr1") => `---\nschema: "contract@1"\ntitle: "${title}"\ndate: "2026-11-24"\nstatus: "open"\n---\n\n# ${title}\n\n## Classification\n\n\`code\`.\n`;

// The message the kernel's contract write refuses `text` at `path` with.
function refusal(root: string, path: string, text: string): string {
  try {
    writeKernelContract(root, { path, text });
  } catch (error) {
    if (error instanceof LedgerError) return error.message;
    throw error;
  }
  throw new Error(`${path} was written`);
}

test("the kernel's contract write puts a split's child's contract in its goal's directory in the run, exactly as given, and the ledger stays valid", () => {
  const root = ledgerWithRun();
  expect(writeKernelContract(root, { path: CHILD, text: contract() })).toBe(CHILD);
  expect(readFileSync(join(root, CHILD), "utf8")).toBe(contract());
  expect(ledger(["validate"], root)).toMatchObject({ code: 0, stdout: "the ledger is valid\n" });
});

test("the kernel's contract write refuses a path that is not a goal's contract in a run, one taken, and a contract the ledger would not be valid with, writing nothing", () => {
  const root = ledgerWithRun();
  const notAContract = (path: string) => `${path}: is not a goal's contract inside a run, <run>/goals/<goal>/contract.md`;
  for (const path of [`${RUN}/contract.md`, `${RUN}/goals/pr1-a/notes.md`, `${RUN}/goals/pr1-a/rounds/contract.md`, `${RUN}/goals/Upper/contract.md`, "projects/alpha/contracts/pr9/contract.md"]) {
    expect(refusal(root, path, contract())).toBe(notAContract(path));
    expect(existsSync(join(root, path))).toBe(false);
  }
  expect(refusal(root, "../outside/contract.md", contract())).toBe("../outside/contract.md: is not a path inside the ledger");
  writeKernelContract(root, { path: CHILD, text: contract() });
  expect(refusal(root, CHILD, contract("Another"))).toBe(`${CHILD} already exists`);
  const other = `${RUN}/goals/pr1-b/contract.md`;
  expect(refusal(root, other, "# No frontmatter\n")).toBe(`${other} would leave the ledger invalid: ${other}: must begin with YAML frontmatter between --- lines`);
  expect(existsSync(join(root, other))).toBe(false);
  expect(refusal(root, other, contract().replace('status: "open"\n', ""))).toContain(`${other} would leave the ledger invalid: ${other}`);
  expect(existsSync(join(root, other))).toBe(false);
  expect(ledger(["validate"], root)).toMatchObject({ code: 0 });
});

test("validate takes a contract only in a goal's directory in a run, and checks it as a contract", () => {
  const root = ledgerWithRun();
  const place = (path: string, text: string): void => {
    mkdirSync(join(root, path, ".."), { recursive: true });
    writeFileSync(join(root, path), text);
  };
  place(`${RUN}/goals/pr1-a/contract.md`, contract().replace('status: "open"\n', ""));
  place(`${RUN}/goals/pr1-b/rounds/contract.md`, contract());
  place(`${RUN}/contract.md`, contract());
  const { code, stdout, stderr } = ledger(["validate"], root);
  const said = stdout + stderr;
  expect(code).toBe(1);
  expect(said).toContain(`${RUN}/goals/pr1-a/contract.md`);
  expect(said).toContain(`${RUN}/goals/pr1-b/rounds/contract.md: does not belong in a run`);
  expect(said).toContain(`${RUN}/contract.md: does not belong in a run`);
});
