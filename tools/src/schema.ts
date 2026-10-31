import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { LedgerError } from "./errors.ts";
import { isObject, type JsonObject } from "./json.ts";
import { parseSchemaName } from "./layout.ts";

// The value types a schema's `type` may name: how a value is recognized, and
// how a problem names the type. Loading and checking both read this table,
// so a type is never accepted without being checked.
const TYPES = {
  object: { holds: isObject, noun: "an object" },
  string: { holds: (value: unknown) => typeof value === "string", noun: "a string" },
  array: { holds: Array.isArray, noun: "a list" },
  integer: { holds: (value: unknown) => typeof value === "number" && Number.isInteger(value), noun: "a whole number" },
  number: { holds: (value: unknown) => typeof value === "number", noun: "a number" },
  boolean: { holds: (value: unknown) => typeof value === "boolean", noun: "true or false" },
} as const;
type TypeName = keyof typeof TYPES;

function isTypeName(value: unknown): value is TypeName {
  return typeof value === "string" && Object.hasOwn(TYPES, value);
}

const isString = (value: unknown): string | undefined => (typeof value === "string" ? undefined : "must be a string");
const isMap = (value: unknown): string | undefined => (isObject(value) ? undefined : "must be an object");
const isCount = (value: unknown): string | undefined =>
  typeof value === "number" && Number.isInteger(value) && value >= 0 ? undefined : "must be a whole number";
const isInteger = (value: unknown): string | undefined =>
  typeof value === "number" && Number.isInteger(value) ? undefined : "must be an integer";
const isScalar = (value: unknown): boolean => value === null || ["string", "number", "boolean"].includes(typeof value);

// Every keyword a schema may use, each with the rule its value must meet.
// Exactly these are implemented: a schema using any other keyword, or one
// of these with a value of the wrong shape, is refused when it loads, so a
// schema can never mean more than the validator checks.
const KEYWORDS: Readonly<Record<string, (value: unknown) => string | undefined>> = {
  $schema: isString,
  title: isString,
  description: isString,
  $ref: isString,
  $defs: isMap,
  properties: isMap,
  items: isMap,
  if: isMap,
  then: isMap,
  type: (v) => (isTypeName(v) ? undefined : `must be one of ${Object.keys(TYPES).join(", ")}`),
  const: () => undefined,
  default: () => undefined,
  enum: (v) => (Array.isArray(v) && v.length > 0 && v.every(isScalar) ? undefined : "must be a non-empty list of plain values"),
  required: (v) =>
    Array.isArray(v) && v.every((item) => typeof item === "string") ? undefined : "must be a list of field names",
  additionalProperties: (v) => (v === false || isObject(v) ? undefined : "may only be false or a schema"),
  minLength: isCount,
  minItems: isCount,
  minimum: isInteger,
  maximum: isInteger,
  uniqueItems: (v) => (v === true ? undefined : "may only be true"),
  pattern: (v) => {
    if (typeof v !== "string") return "must be a string";
    try {
      new RegExp(v, "u");
      return undefined;
    } catch {
      return "must be a regular expression";
    }
  },
};

/** The schemas in one directory, by file name, such as `ledger@1.json`. */
export interface SchemaSet {
  /** Whether a schema file of this name exists. */
  has(file: string): boolean;
  /**
   * Every way `value` breaks the schema at `ref`, a schema file such as `ledger@1.json` or a definition in one
   * such as `defs@1.json#/$defs/name`, each starting with the path of the offending field. Empty when it conforms.
   * @throws {LedgerError} when the schema has a reference that does not resolve, or that leads back to itself.
   */
  check(ref: string, value: unknown): readonly string[];
  /** The newest major version of `kind` with a schema file, or undefined when there is none. */
  newest(kind: string): number | undefined;
  /** The `default` each field of the schema in `file` declares, by field: what a new record starts with. */
  defaults(file: string): JsonObject;
}

function refuseUnsupported(node: unknown, where: string): void {
  if (!isObject(node)) throw new LedgerError(`${where}: a schema must be an object`);
  for (const [key, value] of Object.entries(node)) {
    const rule = Object.hasOwn(KEYWORDS, key) ? KEYWORDS[key] : undefined;
    if (rule === undefined) throw new LedgerError(`${where}: the keyword ${key} is not one the validator implements`);
    const wrong = rule(value);
    if (wrong !== undefined) throw new LedgerError(`${where}: ${key} ${wrong}`);
  }
  for (const group of ["properties", "$defs"] as const) {
    const children = node[group];
    if (!isObject(children)) continue;
    for (const [name, child] of Object.entries(children)) refuseUnsupported(child, `${where}/${group}/${name}`);
  }
  if (node.items !== undefined) refuseUnsupported(node.items, `${where}/items`);
  if (node.if !== undefined) refuseUnsupported(node.if, `${where}/if`);
  if (node.then !== undefined) refuseUnsupported(node.then, `${where}/then`);
  if (isObject(node.additionalProperties)) refuseUnsupported(node.additionalProperties, `${where}/additionalProperties`);
}

/**
 * Loads every `.json` schema in `dir`.
 * @throws {LedgerError} when the directory cannot be read, or a schema is not JSON, or uses a keyword the validator
 * does not implement or a value of the wrong shape.
 */
export function loadSchemas(dir: string): SchemaSet {
  const files = new Map<string, JsonObject>();
  let names: string[];
  try {
    names = readdirSync(dir);
  } catch (error) {
    throw new LedgerError(`cannot read the schemas in ${dir}`, { cause: error });
  }
  for (const file of names.filter((name) => name.endsWith(".json")).sort()) {
    let schema: unknown;
    try {
      schema = JSON.parse(readFileSync(join(dir, file), "utf8"));
    } catch (error) {
      throw new LedgerError(`schema ${file}: not JSON`, { cause: error });
    }
    refuseUnsupported(schema, `schema ${file}`);
    files.set(file, schema as JsonObject);
  }

  function resolve(ref: string, file: string): { readonly node: JsonObject; readonly file: string } {
    const [target = "", pointer = ""] = ref.split("#");
    const targetFile = target === "" ? file : target;
    const name = /^\/\$defs\/([^/]+)$/.exec(pointer)?.[1];
    const defs = files.get(targetFile)?.$defs;
    const node = name !== undefined && isObject(defs) && Object.hasOwn(defs, name) ? defs[name] : undefined;
    if (!isObject(node)) throw new LedgerError(`schema ${file}: cannot resolve ${ref}`);
    return { node, file: targetFile };
  }

  // `followed` holds the references taken since the last step into the value.
  // Seeing one again means the references lead back to themselves without
  // ever reaching the value, which would never end.
  function check(
    node: JsonObject,
    file: string,
    value: unknown,
    path: string,
    problems: string[],
    followed: ReadonlySet<string>,
  ): void {
    const at = path === "" ? "(top)" : path;
    if (typeof node.$ref === "string") {
      const key = `${file}#${node.$ref}`;
      if (followed.has(key)) throw new LedgerError(`schema ${file}: ${node.$ref} leads back to itself`);
      const target = resolve(node.$ref, file);
      check(target.node, target.file, value, path, problems, new Set([...followed, key]));
    }
    if (isTypeName(node.type) && !TYPES[node.type].holds(value)) {
      problems.push(`${at}: must be ${TYPES[node.type].noun}`);
      return;
    }
    if (Object.hasOwn(node, "const") && value !== node.const) {
      problems.push(`${at}: must be ${JSON.stringify(node.const)}`);
    }
    if (Array.isArray(node.enum) && !node.enum.includes(value)) {
      problems.push(`${at}: must be one of ${node.enum.map((v) => JSON.stringify(v)).join(", ")}`);
    }
    if (Array.isArray(value)) {
      if (typeof node.minItems === "number" && value.length < node.minItems) {
        problems.push(`${at}: must have at least ${node.minItems} item${node.minItems === 1 ? "" : "s"}`);
      }
      if (node.uniqueItems === true && new Set(value.map((item) => JSON.stringify(item))).size !== value.length) {
        problems.push(`${at}: must not repeat an item`);
      }
      const items = node.items;
      if (isObject(items)) value.forEach((item, index) => check(items, file, item, `${path}[${index}]`, problems, new Set()));
    }
    if (typeof value === "string") {
      if (typeof node.minLength === "number" && value.length < node.minLength) {
        problems.push(`${at}: must not be empty`);
      }
      if (typeof node.pattern === "string" && !new RegExp(node.pattern, "u").test(value)) {
        problems.push(`${at}: is not in the required form`);
      }
    }
    if (typeof value === "number" && typeof node.minimum === "number" && value < node.minimum) {
      problems.push(`${at}: must be at least ${node.minimum}`);
    }
    if (typeof value === "number" && typeof node.maximum === "number" && value > node.maximum) {
      problems.push(`${at}: must be at most ${node.maximum}`);
    }
    // A value that conforms to `if` is held to `then` as well. What `if` itself
    // finds says only that `then` does not apply; it is no problem of the value.
    // Neither steps into the value, so the references followed so far still count.
    if (isObject(node.if) && isObject(node.then)) {
      const unmet: string[] = [];
      check(node.if, file, value, path, unmet, followed);
      if (unmet.length === 0) check(node.then, file, value, path, problems, followed);
    }
    if (isObject(value)) {
      const properties = isObject(node.properties) ? node.properties : {};
      const required = Array.isArray(node.required) ? node.required : [];
      for (const key of required) {
        if (!Object.hasOwn(value, key)) problems.push(`${path === "" ? "" : `${path}.`}${key}: is required`);
      }
      // A field the schema does not list is checked against `additionalProperties` when that is a
      // schema, which is how a map with any keys is typed.
      const others = isObject(node.additionalProperties) ? node.additionalProperties : undefined;
      for (const [key, child] of Object.entries(value)) {
        const childPath = path === "" ? key : `${path}.${key}`;
        const childSchema = Object.hasOwn(properties, key) ? properties[key] : others;
        if (isObject(childSchema)) check(childSchema, file, child, childPath, problems, new Set());
        else if (node.additionalProperties === false) problems.push(`${childPath}: is not a field of this record`);
      }
    }
  }

  return {
    has: (file) => files.has(file),
    newest(kind) {
      const majors = [...files.keys()].map((file) => parseSchemaName(file.replace(/\.json$/, ""))).filter((name) => name.ok && name.kind === kind);
      return majors.length === 0 ? undefined : Math.max(...majors.map((name) => (name.ok ? name.major : 0)));
    },
    defaults(file) {
      const properties = files.get(file)?.properties;
      if (!isObject(properties)) return {};
      return Object.fromEntries(
        Object.entries(properties).flatMap(([field, schema]) => (isObject(schema) && Object.hasOwn(schema, "default") ? [[field, schema.default]] : [])),
      );
    },
    check(ref, value) {
      const [file = "", pointer] = ref.split("#");
      const schema = files.get(file);
      if (schema === undefined) throw new LedgerError(`no schema ${file}`);
      const target = pointer === undefined ? { node: schema, file } : resolve(ref, file);
      const problems: string[] = [];
      check(target.node, target.file, value, "", problems, new Set());
      return problems;
    },
  };
}
