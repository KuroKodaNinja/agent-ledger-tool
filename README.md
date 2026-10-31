# The agent ledger tool

A ledger is a git repository of planning records: what a project plans,
what it decided and why, the goal contracts its changes were verified
against, its research, the handoffs between working sessions, and the
runs of an orchestrator's kernel over its goals. This tool validates
such a ledger against its own schemas and writes new records into it,
from the command line or as a library. A ledger's own README says what
its records mean, as the
[agent ledger's](https://github.com/KuroKodaNinja/agent-ledger) does for
the ledger this tool was written for; this page says what the tool
enforces and how to run it.

## What a ledger is to the tool

```
ledger.json   the ledger's manifest, a `ledger` record
projects/     one directory per project, holding project.json
programs/     one directory per program, a body of work spanning several
              projects, holding program.json
schema/       one JSON Schema per record kind and major version, the
              ledger's own
```

Every record is versioned. Its `schema` field names its kind and the
major version of that kind's schema, as `<kind>@<major>`, and
`schema/<kind>@<major>.json` in the ledger defines the fields that
version allows. The tool keeps no schemas of its own: it reads the
ledger's, so the schema files are the one list of the versions a ledger
accepts, and a record naming a version with no schema file is refused.
What each kind of record means is the ledger's own README's to say, the
one beside its `ledger.json` (the
[agent ledger's](https://github.com/KuroKodaNinja/agent-ledger) for the
ledger this tool was written for); the tool knows only where each kind
lives:

| Kind | Where |
|---|---|
| `ledger` | `ledger.json` |
| `project` | `projects/<name>/project.json` |
| `program` | `programs/<name>/program.json` |
| `plan`, `decision`, `contract`, `research`, `handoff` | a project's or program's `plans/`, `decisions/`, `contracts/`, `research/`, `handoffs/`, each a Markdown document with YAML frontmatter; a contract is a directory holding `contract.md` |
| `run` | `projects/<name>/runs/<program>/`, a directory of JSON records |
| a run's record kinds | files in a run: the operator's `limits`, `budget-decision` and `vouch`, and the kernel's `attempt`, `round`, `budget-grant`, `budget-request`, `attestation`, `landing`, `goal-state` and `halt` |

## The rules `validate` enforces

- **A record's identity is its path**: no field repeats it. A manifest's
  `name` is its directory's name. Names are lowercase letters, digits
  and hyphens, starting with a letter or digit, at most 63 characters.
- **A project and a program list each other**: a project names a program
  in `programs` exactly when that program names the project in
  `projects`.
- **A document is Markdown with YAML frontmatter**, between `---` lines
  at its top, which is the record. A contract is its directory, holding
  `contract.md` and optionally `evidence/` of anything that shows it was
  met. A decision's number, four digits after the `D` in its file name,
  is unique in its owner and is how `supersedes` and `supersededBy` name
  other decisions; the two lists agree, and a decision is `superseded`
  exactly when something supersedes it.
- **`links` name other records by their paths**, such as
  `projects/alpha/contracts/pr1`, and each must exist. A run's
  `contracts` name goal contracts, and only contracts; a record inside a
  run may carry `links` of its own, checked the same way.
- **A run is a directory record**: `run.json` is its own record, and
  every other file in it, directly or in directories named by the same
  rule as records, is a JSON record whose `schema` names a kind a run
  holds, at a version with a schema file. Nothing else belongs in a run,
  and every directory in it holds a record, directly or beneath it.
- **A path field holds a path inside the ledger**: segments of letters,
  digits, dots, hyphens and underscores, each starting with a letter or
  digit, so never `.` or `..` and never from the root.
- **Nothing sits in the ledger's directories beyond its records**, a
  README in `projects/` and `programs/`, and contracts' evidence. A
  record and the directories holding it must be the file or directory
  itself: a symbolic link is reported, never followed out of the ledger.

## The schemas

The tool validates with the schemas of the ledger it is run on,
implementing a fixed set of JSON Schema keywords and no other: `$schema`,
`title`, `description`, `$ref` to a definition in `$defs` of the same or
another schema file, `properties`, `items`, `if` with `then`, `type`
(one of `object`, `string`, `array`, `integer`, `number`, `boolean`),
`const`, `default`, `enum`, `required`, `additionalProperties` (`false`
or a schema), `minLength`, `minItems`, `minimum`, `maximum`,
`uniqueItems` (`true`) and `pattern`. It refuses to load a schema that
uses any other keyword, or one of those with a value of the wrong shape,
so no schema can mean more than the tool checks.

A change to a schema that every existing record still satisfies, such as
a new optional field, edits the current version. Any other change adds a
new major version beside the old one, as `schema/<kind>@2.json`, so the
ledger accepts both while records move to the new one. Once no record
names the old version, removing its schema file retires it. `new` writes
the newest version of each kind, starting each field its schema gives a
`default` from that default.

## The command line

Run it with Bun from anywhere inside a ledger, or name the ledger with
`--root <dir>`; installed as a dependency, it is `bunx ledger`:

```sh
bunx ledger validate
bunx ledger new project <name> --title <title> --summary <summary> [--repository <owner/name>]
bunx ledger new program <name> --title <title> --summary <summary> --projects <name,...>
bunx ledger new <plan|decision|contract|research|handoff> <name> --in <owner> --title <title> [--date <YYYY-MM-DD>]
bunx ledger new run <program> --in projects/<name> --title <title> [--date <YYYY-MM-DD>]
```

`validate` prints every problem in the ledger, one per line, as
`<file>: <problem>`, and exits with code 1 when there is any. It checks
every record against the schema it names, which must match where the
record is, and every rule above. Control characters in a field name it
repeats are printed as `\u` escapes, so each problem stays on its own
line. A file or the schema directory existing but unreadable fails the
run with an error rather than a problem report, also exit code 1, and
arguments the tool cannot use, such as an option the command does not
take, exit with code 2 and print the usage.

`new` writes a new record. A project or program starts active, and a new
program is added to each project it spans. A document is dated today
unless `--date` says otherwise and has only its title for a body; a new
decision takes the next number in its owner, up to D9999. A run starts
open, with no contracts and only its own record. `new` keeps a valid
ledger valid, so it refuses a ledger that `validate` does not pass, a
name already taken, and a project or owner that does not exist. A
refusal writes nothing, and a write that fails undoes the writes before
it; both exit with code 1.

## As a library

Depend on this repository at one commit, which anyone fetches with no
credential and nothing from a registry, then import the tool by its
package name:

```json
{ "dependencies": { "agent-ledger-tool": "github:KuroKodaNinja/agent-ledger-tool#<commit>" } }
```

```sh
bun install
```

```ts
import { inspectLedger, ledgerSchemas, writeKernelRecord } from "agent-ledger-tool";
```

What the package ships is what the manifest's `files` names, this README
and the tool.

The `exports` map in `package.json` names one module, `tools/src/index.ts`,
which re-exports the surface and nothing else: the kernel's write,
`writeKernelRecord`; the inspection, `inspectLedger`; the schema set of
a ledger at a root, `ledgerSchemas`, and `loadSchemas` for a directory
of schemas; the tables a dependant names paths and kinds with, the
kinds the operator and the kernel write, the folders and the owner
kinds and the run's own file, frozen where they are defined; the
error; and the types each carries. That
module is the one list of the surface. A deep import of any other module
does not resolve.

A run's records have two writers. The operator writes `limits`,
`budget-decision` and `vouch` records. A kernel writes the other kinds,
`attempt` to `halt`, through `writeKernelRecord`, which validates with
the ledger's schemas, as `validate` does, and writes only those kinds: a
kernel asking to write one of the operator's is refused. It also refuses
a ledger that `validate` does not pass, a path outside an existing run or
already taken, and a record that fails the check `validate` applies, and
it takes back a write the ledger would not be valid with, or could not
be inspected with. So it writes nothing, or one record into a ledger that
stays valid.

## Developing

Development needs Bun. `bun install` fetches the pinned type checker,
`bun test` runs the tests, on scratch ledgers that carry their own
schemas, and `bunx tsc --noEmit` checks the types.
