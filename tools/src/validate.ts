import { closeSync, constants, fstatSync, lstatSync, openSync, readdirSync, readFileSync } from "node:fs";
import { basename, join } from "node:path";
import { LedgerError } from "./errors.ts";
import { isObject, type JsonObject } from "./json.ts";
import { CONTRACT_FILE, DECISION_FILE, DocKind, EVIDENCE_DIR, FOLDERS, LEDGER_MANIFEST, manifestFile } from "./layout.ts";
import { NAME_RULE, OWNER_DIR_README, OWNER_DIRS, OwnerKind, parseSchemaName } from "./layout.ts";
import { RUN_FILE, RUN_RECORD_FILE, RUN_RECORD_KINDS, RunKind } from "./layout.ts";
import type { SchemaSet } from "./schema.ts";

/** One way the ledger breaks its rules. */
export interface Problem {
  /** The file, relative to the ledger's root. */
  readonly path: string;
  /** What is wrong with it. */
  readonly message: string;
}

/** A record that conforms to its schema, or every problem that keeps it from conforming. */
export type Checked =
  | { readonly ok: true; readonly record: JsonObject }
  | { readonly ok: false; readonly problems: readonly Problem[] };

/** How a record is written: as a JSON manifest, or as a Markdown document that begins with YAML frontmatter. */
export const Format = { Json: "json", Frontmatter: "frontmatter" } as const;
/** A member of {@link Format}. */
export type Format = (typeof Format)[keyof typeof Format];

/** Why a record's file in the ledger yields no value. */
export const Unreadable = {
  Missing: "is missing",
  NotAFile: "must be a file, not a link or a directory",
  NotJson: "is not JSON",
  NoFrontmatter: "must begin with YAML frontmatter between --- lines",
  NotYaml: "frontmatter: is not YAML",
  Alias: "frontmatter: must not use YAML aliases",
} as const;
/** A member of {@link Unreadable}. */
export type Unreadable = (typeof Unreadable)[keyof typeof Unreadable];

/** A record file's text and the value it holds, or why there is none. */
export type RecordFile =
  | { readonly ok: true; readonly text: string; readonly value: unknown }
  | { readonly ok: false; readonly reason: Unreadable };

function errorCode(error: unknown): unknown {
  return error instanceof Error && "code" in error ? error.code : undefined;
}

const FRONTMATTER = /^---\n([\s\S]*?)\n---(?:\n|$)/;

function parse(text: string, format: Format): { readonly ok: true; readonly value: unknown } | { readonly ok: false; readonly reason: Unreadable } {
  if (format === Format.Json) {
    try {
      return { ok: true, value: JSON.parse(text) };
    } catch {
      return { ok: false, reason: Unreadable.NotJson };
    }
  }
  const frontmatter = FRONTMATTER.exec(text)?.[1];
  if (frontmatter === undefined) return { ok: false, reason: Unreadable.NoFrontmatter };
  let value: unknown;
  try {
    value = Bun.YAML.parse(frontmatter);
  } catch {
    return { ok: false, reason: Unreadable.NotYaml };
  }
  return isTree(value, new Set()) ? { ok: true, value } : { ok: false, reason: Unreadable.Alias };
}

// Whether no list or map is reached twice. A YAML alias reuses one, which
// lets a few lines expand without bound or loop forever.
function isTree(value: unknown, seen: Set<object>): boolean {
  if (typeof value !== "object" || value === null) return true;
  if (seen.has(value)) return false;
  seen.add(value);
  return Object.values(value).every((child) => isTree(child, seen));
}

/**
 * Reads and parses a record's file in the ledger, refusing a link rather than following it out of the ledger.
 * @throws {LedgerError} when the file exists but cannot be read, such as for lack of permission.
 */
export function readRecordFile(root: string, path: string, format: Format): RecordFile {
  let fd: number;
  try {
    // Non-blocking, so a named pipe is refused instead of waited on.
    fd = openSync(join(root, path), constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  } catch (error) {
    if (errorCode(error) === "ENOENT") return { ok: false, reason: Unreadable.Missing };
    if (errorCode(error) === "ELOOP") return { ok: false, reason: Unreadable.NotAFile };
    throw new LedgerError(`cannot read ${path}`, { cause: error });
  }
  let text: string;
  try {
    if (!fstatSync(fd).isFile()) return { ok: false, reason: Unreadable.NotAFile };
    text = readFileSync(fd, "utf8");
  } catch (error) {
    throw new LedgerError(`cannot read ${path}`, { cause: error });
  } finally {
    closeSync(fd);
  }
  const parsed = parse(text, format);
  return parsed.ok ? { ok: true, text, value: parsed.value } : parsed;
}

/**
 * Checks a record against the schema it names, which must be of `kind`. The schema files are the one list of
 * the versions the ledger accepts, so a version with no schema is refused.
 */
export function checkRecord(value: unknown, kind: string, path: string, schemas: SchemaSet): Checked {
  const refuse = (...messages: readonly string[]): Checked => ({
    ok: false,
    problems: messages.map((message) => ({ path, message })),
  });
  if (!isObject(value)) return refuse("must be an object");
  const named = parseSchemaName(value.schema);
  if (!named.ok) return refuse(`schema: must name a kind and major version, such as ${kind}@1`);
  if (named.kind !== kind) return refuse(`schema: is a ${named.kind} record where a ${kind} belongs`);
  const file = `${kind}@${named.major}.json`;
  if (!schemas.has(file)) return refuse(`schema: ${kind}@${named.major} is not a version the ledger accepts`);
  const found = schemas.check(file, value);
  return found.length === 0 ? { ok: true, record: value } : refuse(...found);
}

function names(value: unknown): readonly string[] {
  // Once each: a name listed twice is its own problem, reported by the schema.
  return Array.isArray(value) ? [...new Set(value.filter((item): item is string => typeof item === "string"))] : [];
}

// What a path in the ledger is, without following a link: undefined when nothing is there.
function entryAt(root: string, path: string): { isDirectory(): boolean } | undefined {
  try {
    return lstatSync(join(root, path));
  } catch (error) {
    if (errorCode(error) === "ENOENT") return undefined;
    throw new LedgerError(`cannot read ${path}`, { cause: error });
  }
}

function list(root: string, path: string): string[] {
  try {
    return readdirSync(join(root, path)).sort();
  } catch (error) {
    throw new LedgerError(`cannot read ${path}`, { cause: error });
  }
}

/** A document whose frontmatter is an object, whatever else is wrong with it. */
export interface Document {
  /** Its identity: its path in the ledger, which for a contract is its directory's. */
  readonly id: string;
  /** The file holding it. */
  readonly path: string;
  /** What it records. */
  readonly kind: DocKind;
  /** The project or program it belongs to, as `projects/<name>` or `programs/<name>`. */
  readonly owner: string;
  /** Its frontmatter. */
  readonly record: JsonObject;
}

// A document's name, from its entry in its folder: undefined when the entry
// is not in the form its kind is stored in.
function documentName(kind: DocKind, entry: string): string | undefined {
  if (kind === DocKind.Contract) return entry;
  if (kind === DocKind.Decision) return DECISION_FILE.exec(entry)?.[2];
  return entry.endsWith(".md") ? entry.slice(0, -".md".length) : undefined;
}

function checkFolder(root: string, owner: string, kind: DocKind, schemas: SchemaSet, problems: Problem[], documents: Document[]): void {
  const folder = `${owner}/${FOLDERS[kind]}`;
  if (entryAt(root, folder)?.isDirectory() !== true) {
    problems.push({ path: folder, message: "must be a directory, not a link or a file" });
    return;
  }
  const shape = kind === DocKind.Contract ? "<name> directories" : kind === DocKind.Decision ? "D<number>-<name>.md files" : "<name>.md files";
  for (const entry of list(root, folder)) {
    const path = `${folder}/${entry}`;
    const name = documentName(kind, entry);
    const isDir = entryAt(root, path)?.isDirectory() === true;
    if (name === undefined || schemas.check(NAME_RULE, name).length > 0 || isDir !== (kind === DocKind.Contract)) {
      problems.push({ path, message: `does not belong here: ${FOLDERS[kind]}/ holds only ${shape}, named in lowercase letters, digits, and hyphens` });
      continue;
    }
    if (kind === DocKind.Contract) {
      for (const inner of list(root, path)) {
        const isEvidence = inner === EVIDENCE_DIR && entryAt(root, `${path}/${inner}`)?.isDirectory() === true;
        if (inner !== CONTRACT_FILE && !isEvidence) problems.push({ path: `${path}/${inner}`, message: "does not belong in a contract" });
      }
    }
    const file = kind === DocKind.Contract ? `${path}/${CONTRACT_FILE}` : path;
    const read = readRecordFile(root, file, Format.Frontmatter);
    if (!read.ok) {
      problems.push({ path: file, message: read.reason });
      continue;
    }
    const checked = checkRecord(read.value, kind, file, schemas);
    if (!checked.ok) problems.push(...checked.problems);
    if (isObject(read.value)) documents.push({ id: path, path: file, kind, owner, record: read.value });
  }
}

/** A program's run whose own record is an object, whatever else is wrong with it. */
export interface Run {
  /** Its identity: its directory's path in the ledger. */
  readonly id: string;
  /** The file holding its own record. */
  readonly path: string;
  /** The project it belongs to, as `projects/<name>`. */
  readonly owner: string;
  /** Its own record. */
  readonly record: JsonObject;
  /** The records inside it that are of a kind a run holds, valid or not. */
  readonly records: readonly RunRecord[];
}

/** A record inside a run, of a kind a run holds. */
export interface RunRecord {
  /** The file holding it, which is its identity. */
  readonly path: string;
  /** What it holds. */
  readonly record: JsonObject;
}

const NOT_IN_RUN = "does not belong in a run: a run holds <name>.json records, in directories named in lowercase letters, digits, and hyphens";

// The kind a record's `schema` field names, when it is one a run holds.
function heldKind(record: JsonObject): string | undefined {
  const named = parseSchemaName(record.schema);
  return named.ok && RUN_RECORD_KINDS.includes(named.kind) ? named.kind : undefined;
}

/**
 * Checks a record found inside a run: an object whose `schema` names a kind a run holds, conforming to that kind's
 * schema at the version it names. The one check of such a record, run by `validate` on every file in a run and by
 * the kernel's write before it writes one.
 */
export function checkRunRecord(value: unknown, path: string, schemas: SchemaSet): Checked {
  const refuse = (message: string): Checked => ({ ok: false, problems: [{ path, message }] });
  if (!isObject(value)) return refuse("must be an object");
  const kind = heldKind(value);
  if (kind !== undefined) return checkRecord(value, kind, path, schemas);
  const named = parseSchemaName(value.schema);
  if (!named.ok) return refuse(`schema: must name a kind and major version, such as ${RUN_RECORD_KINDS[0]}@1`);
  return refuse(`schema: is a ${named.kind} record, which a run does not hold; a run holds ${RUN_RECORD_KINDS.join(", ")}`);
}

// Every entry of a run's directory: records as `<name>.json`, each of a kind a run holds, in
// directories named by the name rule, each holding a record directly or beneath it. At the run's
// own directory its own record, run.json, is the caller's to read. Returns whether the directory
// holds a record of a kind a run holds, directly or beneath it.
function checkRunDirectory(root: string, dir: string, schemas: SchemaSet, problems: Problem[], records: RunRecord[], own: boolean): boolean {
  let holdsRecord = false;
  for (const entry of list(root, dir)) {
    const path = `${dir}/${entry}`;
    if (own && entry === RUN_FILE) continue;
    if (entryAt(root, path)?.isDirectory() === true) {
      if (schemas.check(NAME_RULE, entry).length > 0) problems.push({ path, message: NOT_IN_RUN });
      else if (checkRunDirectory(root, path, schemas, problems, records, false)) holdsRecord = true;
      continue;
    }
    const name = RUN_RECORD_FILE.exec(entry)?.[1];
    if (name === undefined || schemas.check(NAME_RULE, name).length > 0) {
      problems.push({ path, message: NOT_IN_RUN });
      continue;
    }
    const read = readRecordFile(root, path, Format.Json);
    if (!read.ok) {
      problems.push({ path, message: read.reason });
      continue;
    }
    const checked = checkRunRecord(read.value, path, schemas);
    if (!checked.ok) problems.push(...checked.problems);
    if (!isObject(read.value) || heldKind(read.value) === undefined) continue;
    records.push({ path, record: read.value });
    holdsRecord = true;
  }
  if (!own && !holdsRecord) problems.push({ path: dir, message: "holds no record" });
  return holdsRecord;
}

// `runRecords` gathers every record inside every run, whatever the state of the run's own record,
// so their links are checked like a document's even when run.json is unreadable.
function checkRuns(root: string, owner: string, schemas: SchemaSet, problems: Problem[], runs: Run[], runRecords: RunRecord[]): void {
  const folder = `${owner}/${FOLDERS[RunKind.Run]}`;
  if (entryAt(root, folder)?.isDirectory() !== true) {
    problems.push({ path: folder, message: "must be a directory, not a link or a file" });
    return;
  }
  for (const entry of list(root, folder)) {
    const path = `${folder}/${entry}`;
    if (entryAt(root, path)?.isDirectory() !== true || schemas.check(NAME_RULE, entry).length > 0) {
      problems.push({ path, message: `does not belong here: ${FOLDERS[RunKind.Run]}/ holds only <program> directories, named in lowercase letters, digits, and hyphens` });
      continue;
    }
    const records: RunRecord[] = [];
    checkRunDirectory(root, path, schemas, problems, records, true);
    runRecords.push(...records);
    const file = `${path}/${RUN_FILE}`;
    const read = readRecordFile(root, file, Format.Json);
    if (!read.ok) {
      problems.push({ path: file, message: read.reason });
      continue;
    }
    const checked = checkRecord(read.value, RunKind.Run, file, schemas);
    if (!checked.ok) problems.push(...checked.problems);
    if (isObject(read.value)) runs.push({ id: path, path: file, owner, record: read.value, records });
  }
}

/** A decision's number, such as D0016, from its file's name. */
export function decisionNumber(document: Document): string {
  return DECISION_FILE.exec(basename(document.path))?.[1] ?? "";
}

// Decision numbers are unique in their project or program, a decision and
// what supersedes it list each other, and a decision is superseded exactly
// when something supersedes it.
function checkDecisions(decisions: readonly Document[], problems: Problem[]): void {
  const byNumber = new Map<string, Document[]>();
  for (const decision of decisions) {
    const key = `${decision.owner} ${decisionNumber(decision)}`;
    byNumber.set(key, [...(byNumber.get(key) ?? []), decision]);
  }
  for (const same of byNumber.values()) {
    for (const decision of same.length > 1 ? same : []) {
      const others = same.filter((other) => other !== decision).map((other) => other.path);
      problems.push({ path: decision.path, message: `its number is also that of ${others.join(", ")}` });
    }
  }
  const pairs = [{ field: "supersedes", back: "supersededBy" }, { field: "supersededBy", back: "supersedes" }] as const;
  for (const decision of decisions) {
    const number = decisionNumber(decision);
    for (const { field, back } of pairs) {
      for (const other of names(decision.record[field])) {
        const targets = byNumber.get(`${decision.owner} ${other}`);
        if (targets === undefined) problems.push({ path: decision.path, message: `${field}: no decision ${other}` });
        else if (!targets.some((target) => names(target.record[back]).includes(number))) {
          problems.push({ path: decision.path, message: `${field}: ${other} does not list this decision in its ${back}` });
        }
      }
    }
    const replaced = names(decision.record.supersededBy).length > 0;
    if (replaced !== (decision.record.status === "superseded")) {
      const message = replaced ? "must be superseded, as supersededBy names what replaces it" : "is superseded, so supersededBy must name what replaces it";
      problems.push({ path: decision.path, message: `status: ${message}` });
    }
  }
}

// The projects or programs in one owner directory: each one's problems, and
// each manifest that is an object, by its directory's name.
function checkOwners(root: string, kind: OwnerKind, schemas: SchemaSet, problems: Problem[], documents: Document[], runs: Run[], runRecords: RunRecord[]): Map<string, Owner> {
  const owners = new Map<string, Owner>();
  const dir = OWNER_DIRS[kind];
  const top = entryAt(root, dir);
  if (top === undefined) return owners;
  if (!top.isDirectory()) {
    problems.push({ path: dir, message: "must be a directory, not a link or a file" });
    return owners;
  }
  for (const entry of list(root, dir)) {
    const path = `${dir}/${entry}`;
    const isDir = entryAt(root, path)?.isDirectory() === true;
    if (!isDir && entry === OWNER_DIR_README) continue;
    if (!isDir || schemas.check(NAME_RULE, entry).length > 0) {
      problems.push({ path, message: `does not belong here: ${dir}/ holds only ${kind} directories, named in lowercase letters, digits, and hyphens` });
      continue;
    }
    for (const inner of list(root, path)) {
      const docKind = Object.values(DocKind).find((candidate) => FOLDERS[candidate] === inner);
      if (docKind !== undefined) checkFolder(root, path, docKind, schemas, problems, documents);
      else if (inner === FOLDERS[RunKind.Run] && kind === OwnerKind.Project) checkRuns(root, path, schemas, problems, runs, runRecords);
      else if (inner !== manifestFile(kind)) problems.push({ path: `${path}/${inner}`, message: `does not belong in a ${kind}` });
    }
    const manifestPath = `${path}/${manifestFile(kind)}`;
    const file = readRecordFile(root, manifestPath, Format.Json);
    if (!file.ok) {
      problems.push({ path: manifestPath, message: file.reason });
      continue;
    }
    const checked = checkRecord(file.value, kind, manifestPath, schemas);
    if (!checked.ok) problems.push(...checked.problems);
    if (!isObject(file.value)) continue;
    if (file.value.name !== entry) {
      problems.push({ path: manifestPath, message: `name: must be ${JSON.stringify(entry)}, the directory's name` });
    }
    // Kept whatever else is wrong with it, so its links are checked too and
    // no other manifest's link to it is reported as leading nowhere.
    owners.set(entry, { record: file.value, text: file.text });
  }
  return owners;
}

/** A project or program, by its directory, whose manifest is an object. */
export interface Owner {
  /** Its manifest. */
  readonly record: JsonObject;
  /** Its manifest's text, as the file holds it. */
  readonly text: string;
}

/** What the ledger holds: every problem, and its projects and programs by name. */
export interface Inspection {
  /** Every problem, sorted by file. Empty when the ledger is valid. */
  readonly problems: readonly Problem[];
  /** The projects whose manifests are objects; all of them are valid when there is no problem. */
  readonly projects: ReadonlyMap<string, Owner>;
  /** The programs whose manifests are objects; all of them are valid when there is no problem. */
  readonly programs: ReadonlyMap<string, Owner>;
  /** The documents whose frontmatter is an object; all of them are valid when there is no problem. */
  readonly documents: readonly Document[];
  /** The runs whose own records are objects; all of them and their records are valid when there is no problem. */
  readonly runs: readonly Run[];
}

/**
 * Checks the ledger at `root` against every rule.
 * @throws {LedgerError} when a file exists but cannot be read.
 */
export function inspectLedger(root: string, schemas: SchemaSet): Inspection {
  const problems: Problem[] = [];
  const file = readRecordFile(root, LEDGER_MANIFEST, Format.Json);
  if (!file.ok) problems.push({ path: LEDGER_MANIFEST, message: file.reason });
  else {
    const checked = checkRecord(file.value, "ledger", LEDGER_MANIFEST, schemas);
    if (!checked.ok) problems.push(...checked.problems);
  }
  const documents: Document[] = [];
  const runs: Run[] = [];
  const runRecords: RunRecord[] = [];
  const projects = checkOwners(root, OwnerKind.Project, schemas, problems, documents, runs, runRecords);
  const programs = checkOwners(root, OwnerKind.Program, schemas, problems, documents, runs, runRecords);

  // A project and a program each list the other, or neither does.
  const pairs = [
    { owners: projects, kind: OwnerKind.Project, field: "programs", others: programs, otherKind: OwnerKind.Program, back: "projects" },
    { owners: programs, kind: OwnerKind.Program, field: "projects", others: projects, otherKind: OwnerKind.Project, back: "programs" },
  ] as const;
  for (const { owners, kind, field, others, otherKind, back } of pairs) {
    for (const [name, { record }] of owners) {
      const path = `${OWNER_DIRS[kind]}/${name}/${manifestFile(kind)}`;
      for (const other of names(record[field])) {
        const otherOwner = others.get(other);
        if (otherOwner === undefined) problems.push({ path, message: `${field}: no ${otherKind} named ${other}` });
        else if (!names(otherOwner.record[back]).includes(name)) {
          problems.push({ path, message: `${field}: ${otherKind} ${other} does not list this ${kind} in its ${back}` });
        }
      }
    }
  }
  checkDecisions(documents.filter((document) => document.kind === DocKind.Decision), problems);

  // A record links only to records that exist: projects, programs, documents, runs, and the records
  // inside runs. A run's contracts name only goal contracts, so a kernel reading them finds a
  // contract and never another kind of record.
  const records = new Set([
    ...[...projects.keys()].map((name) => `${OWNER_DIRS.project}/${name}`),
    ...[...programs.keys()].map((name) => `${OWNER_DIRS.program}/${name}`),
    ...documents.map((document) => document.id),
    ...runs.map((run) => run.id),
    ...runRecords.map((record) => record.path),
  ]);
  const contracts = new Set(documents.filter((document) => document.kind === DocKind.Contract).map((document) => document.id));
  const linked = [...documents, ...runs, ...runRecords];
  const references = [
    ...linked.map(({ path, record }) => ({ path, field: "links", targets: names(record.links), among: records, noun: "record" })),
    ...runs.map((run) => ({ path: run.path, field: "contracts", targets: names(run.record.contracts), among: contracts, noun: "contract" })),
  ];
  for (const { path, field, targets, among, noun } of references) {
    for (const target of targets) {
      if (!among.has(target)) problems.push({ path, message: `${field}: no ${noun} at ${target}` });
    }
  }
  problems.sort((x, y) => x.path.localeCompare(y.path) || x.message.localeCompare(y.message));
  return { problems, projects, programs, documents, runs };
}
