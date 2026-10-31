import { existsSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { LedgerError } from "./errors.ts";

/** The ledger's manifest, at its root. */
export const LEDGER_MANIFEST = "ledger.json";

/** The directory of a ledger holding its schemas, one per record kind and major version. */
export const SCHEMA_FOLDER = "schema";

/** A record's `schema` field taken apart: its kind and major version, or a refusal when it is not `<kind>@<major>`. */
export type SchemaName =
  | { readonly ok: true; readonly kind: string; readonly major: number }
  | { readonly ok: false };

/** Takes a record's `schema` field apart. */
export function parseSchemaName(value: unknown): SchemaName {
  const match = typeof value === "string" ? /^([a-z]+(?:-[a-z]+)*)@([1-9][0-9]*)$/.exec(value) : null;
  if (match?.[1] === undefined || match[2] === undefined) return { ok: false };
  return { ok: true, kind: match[1], major: Number(match[2]) };
}

/**
 * The ledger that `start` lies in: the nearest directory, `start` itself or above it, holding a ledger manifest.
 * @throws {LedgerError} when there is none.
 */
export function findRoot(start: string): string {
  for (let dir = resolve(start); ; dir = dirname(dir)) {
    if (existsSync(join(dir, LEDGER_MANIFEST))) return dir;
    if (dirname(dir) === dir) throw new LedgerError(`no ${LEDGER_MANIFEST} in ${resolve(start)} or above it`);
  }
}

/** What a top-level ledger directory holds: a project, or a program spanning several projects. */
export const OwnerKind = Object.freeze({ Project: "project", Program: "program" } as const);
/** A member of {@link OwnerKind}. */
export type OwnerKind = (typeof OwnerKind)[keyof typeof OwnerKind];

/** The directory of the ledger that holds each kind of owner. */
export const OWNER_DIRS: Readonly<Record<OwnerKind, string>> = Object.freeze({ project: "projects", program: "programs" });

/** A file allowed beside the owners in `projects/` and `programs/`, saying what the directory is for. */
export const OWNER_DIR_README = "README.md";

/** The schema definition a project's or program's name, and so its directory's, must meet. */
export const NAME_RULE = "defs@1.json#/$defs/name";

/** The schema definition a path inside the ledger, as a record's field or a write names one, must meet. */
export const PATH_RULE = "defs@1.json#/$defs/path";

/** What a project or program records beside its manifest, each kind in a folder of its own. */
export const DocKind = Object.freeze({ Plan: "plan", Decision: "decision", Contract: "contract", Research: "research", Handoff: "handoff" } as const);
/** A member of {@link DocKind}. */
export type DocKind = (typeof DocKind)[keyof typeof DocKind];

/** A program's run, which only a project holds: a directory of JSON records, each of a kind in {@link RUN_RECORD_KINDS}. */
export const RunKind = Object.freeze({ Run: "run" } as const);
/** A member of {@link RunKind}. */
export type RunKind = (typeof RunKind)[keyof typeof RunKind];

/** The one table of what an owner keeps beside its manifest, each kind in a folder of its own: the documents, and a project's runs. */
export const FOLDERS: Readonly<Record<DocKind | RunKind, string>> = Object.freeze({
  plan: "plans",
  decision: "decisions",
  contract: "contracts",
  research: "research",
  handoff: "handoffs",
  run: "runs",
});

/** A contract is a directory holding this file, and optionally {@link EVIDENCE_DIR}. */
export const CONTRACT_FILE = "contract.md";
/** A contract's directory of whatever shows it was met, in any form. */
export const EVIDENCE_DIR = "evidence";

/** A decision's file name: D, its number in its project or program, and its name. */
export const DECISION_FILE = /^(D[0-9]{4})-(.*)\.md$/;

/** The file a run's own record is in, inside its directory. */
export const RUN_FILE = "run.json";

// The tables below decide what the tool accepts and what a kernel may write, and the library hands them to
// dependants, so each is frozen where it is defined: no caller can widen one at run time.

/** The kinds of record the operator writes into a run: what a kernel may run and spend, and the operator's answers. */
export const OPERATOR_RECORD_KINDS: readonly string[] = Object.freeze(["limits", "budget-decision", "vouch"]);

/** The kinds of record a kernel writes into a run, through the tool's kernel write and nothing else: what the run produced. */
export const KERNEL_RECORD_KINDS: readonly string[] = Object.freeze(["attempt", "round", "budget-grant", "budget-request", "attestation", "landing", "goal-state", "halt"]);

/** The kinds of record a run's files may hold, each validated against the kind its own `schema` field names. */
export const RUN_RECORD_KINDS: readonly string[] = Object.freeze([...OPERATOR_RECORD_KINDS, ...KERNEL_RECORD_KINDS]);

/** A run record's file name: its name and the JSON suffix. */
export const RUN_RECORD_FILE = /^(.*)\.json$/;

/** The file an owner's manifest is in, inside its directory. */
export function manifestFile(kind: OwnerKind): string {
  return `${kind}.json`;
}
