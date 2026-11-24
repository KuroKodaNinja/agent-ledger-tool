import { closeSync, constants, lstatSync, mkdirSync, openSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { isDeepStrictEqual } from "node:util";
import { basename, dirname, join } from "node:path";
import { LedgerError, UsageError } from "./errors.ts";
import type { JsonObject } from "./json.ts";
import { CONTRACT_FILE, DECISION_FILE, DocKind, FOLDERS, manifestFile, NAME_RULE, OWNER_DIRS, OwnerKind } from "./layout.ts";
import { KERNEL_RECORD_KINDS, parseSchemaName, PATH_RULE, RUN_FILE, RUN_GOALS_DIR, RunKind } from "./layout.ts";
import { ledgerSchemas, type SchemaSet } from "./schema.ts";
import { checkRunRecord, decisionNumber, type Inspection, inspectLedger, type Problem } from "./validate.ts";

/** What a new project needs. */
export interface NewProject {
  /** Its name, which is also its directory's. */
  readonly name: string;
  /** What it is called. */
  readonly title: string;
  /** What it is, in a sentence or two. */
  readonly summary: string;
  /** Its GitHub repository, owner/name, when it has one. */
  readonly repository?: string;
}

/** What a new program needs. */
export interface NewProgram {
  /** Its name, which is also its directory's. */
  readonly name: string;
  /** What it is called. */
  readonly title: string;
  /** What it is, in a sentence or two. */
  readonly summary: string;
  /** The existing projects it spans; each gains the program in its own list. */
  readonly projects: readonly string[];
}

/** What a new document needs. */
export interface NewDocument {
  /** What it records. */
  readonly kind: DocKind;
  /** Its name; a decision's file name also carries its number. */
  readonly name: string;
  /** The project or program it belongs to, as `projects/<name>` or `programs/<name>`. */
  readonly owner: string;
  /** What it is called. */
  readonly title: string;
  /** The day it is dated, as YYYY-MM-DD. */
  readonly date: string;
}

/** What a new run needs. */
export interface NewRun {
  /** Its name, the program's, which is also its directory's. */
  readonly name: string;
  /** The project it belongs to, as `projects/<name>`. */
  readonly owner: string;
  /** What it is called. */
  readonly title: string;
  /** The day it is dated, as YYYY-MM-DD. */
  readonly date: string;
}

/** What a kernel's record needs. */
export interface NewKernelRecord {
  /** Where it goes: its path in the ledger, inside an existing run, which becomes its identity. */
  readonly path: string;
  /** The record, whose `schema` field names a kind a kernel writes. */
  readonly record: JsonObject;
}

/** A contract a kernel writes into a run, for a goal a split made: where it goes, and its text, a Markdown document beginning with its frontmatter. */
export interface NewKernelContract {
  /** Where it goes: `<run>/goals/<goal>/contract.md`, inside an existing run, for a goal by a name. */
  readonly path: string;
  /** Its whole text. */
  readonly text: string;
}

/** A run as its Program declares it, which a kernel writes through {@link declareRun}. */
export interface RunDeclaration {
  /** The run's path in the ledger, `projects/<project>/runs/<name>`; its name is the program's. */
  readonly run: string;
  /** What it is called. */
  readonly title: string;
  /** The day it is declared, as YYYY-MM-DD. */
  readonly date: string;
  /** The goal contracts it drives, by their paths in the ledger, in order. */
  readonly contracts: readonly string[];
  /** The product repository its goals change. */
  readonly repository: { readonly remote: string; readonly branch: string };
  /** Its limits, a limits record as the operator wrote it. */
  readonly limits: JsonObject;
}

/** What {@link declareRun} did. */
export interface DeclaredRun {
  /** The run's path in the ledger. */
  readonly run: string;
  /** Whether it made the run. */
  readonly created: boolean;
  /** The limits version now latest, the one just written or the one the limits equal. */
  readonly limits: number;
}

/** The directory in a run that holds its limits, one version per file, `<n>.json` from 1. */
export const LIMITS_DIR = "limits";

/** The last number a decision's four digits can hold. */
const MAX_DECISION = 9999;

/** A record to write, by its path in the ledger. */
interface Write {
  readonly path: string;
  readonly text: string;
}

/** An existing manifest to write over, with the text it holds now. */
interface Replacement extends Write {
  readonly before: string;
}

const REPLACE = constants.O_WRONLY | constants.O_TRUNC | constants.O_NOFOLLOW;

const asText = (record: JsonObject): string => `${JSON.stringify(record, null, 2)}\n`;

// A JSON string is also a YAML scalar, so each field is written as JSON.
const asDocument = (record: JsonObject): string =>
  `---\n${Object.entries(record).map(([key, value]) => `${key}: ${JSON.stringify(value)}`).join("\n")}\n---\n\n# ${String(record.title)}\n`;

// `truncated` runs once the file is emptied, so a caller knows it must be restored.
function overwrite(file: string, text: string, truncated: () => void): void {
  const fd = openSync(file, REPLACE);
  try {
    truncated();
    writeFileSync(fd, text);
  } finally {
    closeSync(fd);
  }
}

// Writes a new record, then the manifests it changes, and undoes them all
// when one fails, so a failure leaves the ledger as it was. No write follows
// a link. Returns the undo, for a caller that must take the writes back.
function commit(root: string, created: Write, replacements: readonly Replacement[]): () => void {
  const touched: Replacement[] = [];
  let made: string | undefined;
  let wrote = false;
  const undo = (): void => {
    for (const replacement of touched) overwrite(join(root, replacement.path), replacement.before, () => {});
    if (made !== undefined) rmSync(made, { recursive: true });
    else if (wrote) rmSync(join(root, created.path));
  };
  let failing = created.path;
  try {
    made = mkdirSync(dirname(join(root, created.path)), { recursive: true });
    writeFileSync(join(root, created.path), created.text, { flag: "wx" });
    wrote = true;
    for (const replacement of replacements) {
      failing = replacement.path;
      overwrite(join(root, replacement.path), replacement.text, () => touched.push(replacement));
    }
  } catch (error) {
    try {
      undo();
    } catch (undoing) {
      throw new LedgerError(`cannot write ${failing}, nor undo the writes before it; run ledger validate`, { cause: undoing });
    }
    throw new LedgerError(`cannot write ${failing}`, { cause: error });
  }
  return undo;
}

function checkName(schemas: SchemaSet, kind: OwnerKind | DocKind | RunKind, name: string): void {
  if (schemas.check(NAME_RULE, name).length > 0) {
    throw new UsageError(`${kind} name ${JSON.stringify(name)}: use lowercase letters, digits, and hyphens, starting with a letter or digit`);
  }
}

// A new record of `kind` in the newest version the ledger accepts: `fields`,
// then each default that version's schema declares for a field not given.
function newRecord(schemas: SchemaSet, kind: OwnerKind | DocKind | RunKind, fields: JsonObject): JsonObject {
  const major = schemas.newest(kind);
  if (major === undefined) throw new LedgerError(`the ledger accepts no ${kind} records`);
  const file = `${kind}@${major}.json`;
  const defaults = Object.entries(schemas.defaults(file)).filter(([field]) => !Object.hasOwn(fields, field));
  const record = { schema: `${kind}@${major}`, ...fields, ...Object.fromEntries(defaults) };
  const problems = schemas.check(file, record);
  if (problems.length > 0) throw new UsageError(problems.join("; "));
  return record;
}

// The commands keep a valid ledger valid, so they change only a valid one.
function validLedger(root: string, schemas: SchemaSet): Inspection {
  const inspection = inspectLedger(root, schemas);
  if (inspection.problems.length > 0) throw new LedgerError("the ledger is not valid; run ledger validate");
  return inspection;
}

function inspectForNew(root: string, schemas: SchemaSet, kind: OwnerKind, name: string): Inspection {
  const inspection = validLedger(root, schemas);
  const owners = kind === OwnerKind.Project ? inspection.projects : inspection.programs;
  if (owners.has(name)) throw new LedgerError(`${OWNER_DIRS[kind]}/${name} already exists`);
  return inspection;
}

/**
 * Creates `projects/<name>/project.json`, starting from its schema's defaults, and returns its path in the ledger.
 * @throws {UsageError} when an argument breaks the project schema.
 * @throws {LedgerError} when the ledger is not valid, the name is taken, or the manifest cannot be written.
 */
export function createProject(root: string, schemas: SchemaSet, input: NewProject): string {
  checkName(schemas, OwnerKind.Project, input.name);
  const record = newRecord(schemas, OwnerKind.Project, {
    name: input.name,
    title: input.title,
    summary: input.summary,
    ...(input.repository === undefined ? {} : { repository: input.repository }),
  });
  inspectForNew(root, schemas, OwnerKind.Project, input.name);
  const path = `${OWNER_DIRS.project}/${input.name}`;
  commit(root, { path: `${path}/${manifestFile(OwnerKind.Project)}`, text: asText(record) }, []);
  return path;
}

/**
 * Creates `programs/<name>/program.json`, spanning `projects`, adds the program to each of those
 * projects, and returns its path in the ledger.
 * @throws {UsageError} when an argument breaks the program schema.
 * @throws {LedgerError} when the ledger is not valid, the name is taken, a project does not exist, or a
 * manifest cannot be written.
 */
export function createProgram(root: string, schemas: SchemaSet, input: NewProgram): string {
  checkName(schemas, OwnerKind.Program, input.name);
  const record = newRecord(schemas, OwnerKind.Program, {
    name: input.name,
    title: input.title,
    summary: input.summary,
    projects: [...input.projects],
  });
  const { projects } = inspectForNew(root, schemas, OwnerKind.Program, input.name);

  const replacements = input.projects.map((project): Replacement => {
    const owner = projects.get(project);
    if (owner === undefined) throw new LedgerError(`no project named ${project}`);
    const path = `${OWNER_DIRS.project}/${project}/${manifestFile(OwnerKind.Project)}`;
    const programs = Array.isArray(owner.record.programs) ? owner.record.programs : [];
    return { path, before: owner.text, text: asText({ ...owner.record, programs: [...programs, input.name] }) };
  });

  const path = `${OWNER_DIRS.program}/${input.name}`;
  commit(root, { path: `${path}/${manifestFile(OwnerKind.Program)}`, text: asText(record) }, replacements);
  return path;
}

/**
 * Creates a dated document, starting from its schema's defaults, in its project's or program's folder for its kind,
 * and returns its path in the ledger. A new decision takes the next number in its project or program.
 * @throws {UsageError} when an argument breaks the document's schema.
 * @throws {LedgerError} when the ledger is not valid, the owner does not exist, the name is taken, or the
 * document cannot be written.
 */
export function createDocument(root: string, schemas: SchemaSet, input: NewDocument): string {
  checkName(schemas, input.kind, input.name);
  const record = newRecord(schemas, input.kind, { title: input.title, date: input.date });
  const inspection = validLedger(root, schemas);
  const owners = [
    ...[...inspection.projects.keys()].map((name) => `${OWNER_DIRS.project}/${name}`),
    ...[...inspection.programs.keys()].map((name) => `${OWNER_DIRS.program}/${name}`),
  ];
  if (!owners.includes(input.owner)) throw new LedgerError(`no project or program at ${input.owner}`);

  const folder = `${input.owner}/${FOLDERS[input.kind]}`;
  const siblings = inspection.documents.filter((document) => document.owner === input.owner && document.kind === input.kind);
  let id = `${folder}/${input.name}${input.kind === DocKind.Contract ? "" : ".md"}`;
  if (input.kind === DocKind.Decision) {
    const taken = siblings.find((document) => DECISION_FILE.exec(basename(document.path))?.[2] === input.name);
    if (taken !== undefined) throw new LedgerError(`${taken.id} already exists`);
    const next = Math.max(0, ...siblings.map((document) => Number(decisionNumber(document).slice(1)))) + 1;
    if (next > MAX_DECISION) throw new LedgerError(`${folder} has no decision number left after D${MAX_DECISION}`);
    id = `${folder}/D${String(next).padStart(4, "0")}-${input.name}.md`;
  }
  if (siblings.some((document) => document.id === id)) throw new LedgerError(`${id} already exists`);
  commit(root, { path: input.kind === DocKind.Contract ? `${id}/${CONTRACT_FILE}` : id, text: asDocument(record) }, []);
  return id;
}

/**
 * Creates a run's directory and its own record, `run.json`, under its project's `runs/`, starting from the run
 * schema's defaults, and returns the directory's path in the ledger.
 * @throws {UsageError} when an argument breaks the run schema.
 * @throws {LedgerError} when the ledger is not valid, the owner is not a project, the name is taken, or the
 * record cannot be written.
 */
export function createRun(root: string, schemas: SchemaSet, input: NewRun): string {
  checkName(schemas, RunKind.Run, input.name);
  const record = newRecord(schemas, RunKind.Run, { title: input.title, date: input.date });
  const inspection = validLedger(root, schemas);
  const projects = [...inspection.projects.keys()].map((name) => `${OWNER_DIRS.project}/${name}`);
  if (!projects.includes(input.owner)) throw new LedgerError(`no project at ${input.owner}`);
  const id = `${input.owner}/${FOLDERS[RunKind.Run]}/${input.name}`;
  if (inspection.runs.some((run) => run.id === id)) throw new LedgerError(`${id} already exists`);
  commit(root, { path: `${id}/${RUN_FILE}`, text: asText(record) }, []);
  return id;
}

const describe = (problems: readonly Problem[]): string => problems.map((problem) => `${problem.path}: ${problem.message}`).join("; ");

// Takes a kernel's write back, and says the ledger needs looking at when that fails too.
function takeBack(undo: () => void, path: string): void {
  try {
    undo();
  } catch (error) {
    throw new LedgerError(`${path} leaves the ledger invalid and cannot be taken back; run ledger validate`, { cause: error });
  }
}

/**
 * Writes one of a kernel's records inside a run, which is how a kernel records what a program's run produces, and
 * returns its path in the ledger. It validates with the schemas of the ledger at `root`, exactly as `validate` does.
 * It writes only the kinds a kernel writes, never the operator's; it writes nothing else; and it takes the write
 * back when the ledger would not be valid with it, or cannot be inspected with it, so a write that returns leaves a
 * valid ledger.
 * @throws {LedgerError} when the record is not a valid record of a kind a kernel writes, the ledger is not valid,
 * the path is not inside an existing run or already holds something, the ledger would not be valid with the record,
 * or the record cannot be written.
 */
export function writeKernelRecord(root: string, input: NewKernelRecord): string {
  const schemas = ledgerSchemas(root);
  const named = parseSchemaName(input.record.schema);
  if (named.ok && !KERNEL_RECORD_KINDS.includes(named.kind)) {
    throw new LedgerError(`${input.path}: schema: is a ${named.kind} record, which a kernel does not write; a kernel writes ${KERNEL_RECORD_KINDS.join(", ")}`);
  }
  const checked = checkRunRecord(input.record, input.path, schemas);
  if (!checked.ok) throw new LedgerError(describe(checked.problems));
  if (schemas.check(PATH_RULE, input.path).length > 0) throw new LedgerError(`${input.path}: is not a path inside the ledger`);
  const { runs } = validLedger(root, schemas);
  if (!runs.some((run) => input.path.startsWith(`${run.id}/`))) throw new LedgerError(`${input.path} is not inside a run`);
  if (lstatSync(join(root, input.path), { throwIfNoEntry: false }) !== undefined) throw new LedgerError(`${input.path} already exists`);
  const undo = commit(root, { path: input.path, text: asText(input.record) }, []);
  let problems: readonly Problem[];
  try {
    problems = inspectLedger(root, schemas).problems;
  } catch (error) {
    takeBack(undo, input.path);
    throw new LedgerError(`${input.path} was taken back: the ledger could not be inspected with it`, { cause: error });
  }
  if (problems.length === 0) return input.path;
  takeBack(undo, input.path);
  throw new LedgerError(`${input.path} would leave the ledger invalid: ${describe(problems)}`);
}

/**
 * Writes the contract a split made for a goal of a run, at `<run>/goals/<goal>/contract.md`, and returns its path in
 * the ledger. It validates the contract with the schemas of the ledger at `root`, exactly as `validate` does, writes
 * nothing else, and takes the write back when the ledger would not be valid with it, so a write that returns leaves a
 * valid ledger.
 * @throws {LedgerError} when the path is not a goal's contract inside an existing run or already holds something, the
 * text is not a valid contract, the ledger is not valid, or the ledger would not be valid with it.
 */
export function writeKernelContract(root: string, input: NewKernelContract): string {
  const schemas = ledgerSchemas(root);
  if (schemas.check(PATH_RULE, input.path).length > 0) throw new LedgerError(`${input.path}: is not a path inside the ledger`);
  const { runs } = validLedger(root, schemas);
  const run = runs.find((one) => input.path.startsWith(`${one.id}/${RUN_GOALS_DIR}/`));
  const goal = run === undefined ? undefined : input.path.slice(`${run.id}/${RUN_GOALS_DIR}/`.length).split("/");
  if (run === undefined || goal?.length !== 2 || goal[1] !== CONTRACT_FILE || schemas.check(NAME_RULE, goal[0] ?? "").length > 0) {
    throw new LedgerError(`${input.path}: is not a goal's contract inside a run, <run>/${RUN_GOALS_DIR}/<goal>/${CONTRACT_FILE}`);
  }
  if (lstatSync(join(root, input.path), { throwIfNoEntry: false }) !== undefined) throw new LedgerError(`${input.path} already exists`);
  const undo = commit(root, { path: input.path, text: input.text }, []);
  let problems: readonly Problem[];
  try {
    problems = inspectLedger(root, schemas).problems;
  } catch (error) {
    takeBack(undo, input.path);
    throw new LedgerError(`${input.path} was taken back: the ledger could not be inspected with it`, { cause: error });
  }
  if (problems.length === 0) return input.path;
  takeBack(undo, input.path);
  throw new LedgerError(`${input.path} would leave the ledger invalid: ${describe(problems)}`);
}

// A run's path, `projects/<project>/runs/<name>`, split into its project and name.
const RUN_PATH = new RegExp(`^${OWNER_DIRS.project}/([^/]+)/${FOLDERS[RunKind.Run]}/([^/]+)$`);

// The limits versions a run holds, by number, from its limits directory.
function limitsVersions(root: string, run: string): readonly number[] {
  const dir = join(root, run, LIMITS_DIR);
  if (lstatSync(dir, { throwIfNoEntry: false }) === undefined) return [];
  return readdirSync(dir).flatMap((file) => {
    const version = /^([1-9][0-9]*)\.json$/.exec(file)?.[1];
    return version === undefined ? [] : [Number(version)];
  });
}

const readJson = (root: string, path: string): unknown => JSON.parse(readFileSync(join(root, path), "utf8"));

// Writes each record in turn, undoing those before when one fails; returns the undo of them all.
function commitAll(root: string, writes: readonly Write[]): () => void {
  const undos: (() => void)[] = [];
  const undo = (): void => {
    for (const each of undos.reverse()) each();
  };
  try {
    for (const write of writes) undos.push(commit(root, write, []));
  } catch (error) {
    takeBack(undo, writes[0]?.path ?? "");
    throw error;
  }
  return undo;
}

/**
 * Writes a run as its Program declares it, the one way a kernel writes an operator's record. A run that does not
 * exist is made, open, with its `run.json` naming the declaration's contracts and repository, and its limits as
 * `limits/1.json`. A run that exists must already declare those contracts, in that order, and that repository; its
 * limits are written as the next version only when they differ from its latest. What is written is written together,
 * and taken back when the ledger would not be valid with it, so a call that returns leaves a valid ledger.
 * @throws {UsageError} when the run's name or the run record breaks the run schema.
 * @throws {LedgerError} when the ledger is not valid, the path is not a run's in an existing project, the run declares
 * other contracts or another repository, the limits are not a valid limits record, the ledger would not be valid with
 * what is written, or it cannot be written.
 */
export function declareRun(root: string, input: RunDeclaration): DeclaredRun {
  const schemas = ledgerSchemas(root);
  const [, project, name] = RUN_PATH.exec(input.run) ?? [];
  if (project === undefined || name === undefined) throw new LedgerError(`${input.run}: is not a run's path, projects/<project>/runs/<name>`);
  checkName(schemas, RunKind.Run, name);
  const named = parseSchemaName(input.limits.schema);
  if (!named.ok || named.kind !== "limits") throw new LedgerError(`${input.run}/${LIMITS_DIR}: schema: must name a limits record`);
  const inspection = validLedger(root, schemas);
  const exists = inspection.runs.some((run) => run.id === input.run);
  const writes: Write[] = [];
  let version = 1;
  if (!exists) {
    if (!inspection.projects.has(project)) throw new LedgerError(`no project at ${OWNER_DIRS.project}/${project}`);
    const record = newRecord(schemas, RunKind.Run, { title: input.title, date: input.date, contracts: [...input.contracts], repository: { remote: input.repository.remote, branch: input.repository.branch } });
    writes.push({ path: `${input.run}/${RUN_FILE}`, text: asText(record) });
  } else {
    const held = readJson(root, `${input.run}/${RUN_FILE}`) as { contracts?: unknown; repository?: unknown };
    if (!isDeepStrictEqual(held.contracts ?? [], [...input.contracts])) throw new LedgerError(`${input.run}: already declares the contracts ${JSON.stringify(held.contracts ?? [])}, not ${JSON.stringify(input.contracts)}`);
    const repository = { remote: input.repository.remote, branch: input.repository.branch };
    if (!isDeepStrictEqual(held.repository, repository)) throw new LedgerError(`${input.run}: already declares the repository ${JSON.stringify(held.repository ?? null)}, not ${JSON.stringify(repository)}`);
    const latest = Math.max(0, ...limitsVersions(root, input.run));
    if (latest > 0 && isDeepStrictEqual(readJson(root, `${input.run}/${LIMITS_DIR}/${latest}.json`), input.limits)) return { run: input.run, created: false, limits: latest };
    version = latest + 1;
  }
  const limitsPath = `${input.run}/${LIMITS_DIR}/${version}.json`;
  const checked = checkRunRecord(input.limits, limitsPath, schemas);
  if (!checked.ok) throw new LedgerError(describe(checked.problems));
  writes.push({ path: limitsPath, text: asText(input.limits) });
  const undo = commitAll(root, writes);
  let problems: readonly Problem[];
  try {
    problems = inspectLedger(root, schemas).problems;
  } catch (error) {
    takeBack(undo, input.run);
    throw new LedgerError(`${input.run} was taken back: the ledger could not be inspected with it`, { cause: error });
  }
  if (problems.length > 0) {
    takeBack(undo, input.run);
    throw new LedgerError(`${input.run} would leave the ledger invalid: ${describe(problems)}`);
  }
  return { run: input.run, created: !exists, limits: version };
}
