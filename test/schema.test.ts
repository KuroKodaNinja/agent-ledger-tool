import { expect, test } from "bun:test";
import { chmodSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { emptyLedger, ledger, ledgerWithSchemas, problems, withoutSuperuser } from "./support.ts";

// Each test runs the tool on a ledger carrying schemas of its own and a
// manifest the test writes, and observes only what the tool prints.
function validate(schemas: Readonly<Record<string, unknown>>, manifest: string | object) {
  const root = ledgerWithSchemas(schemas);
  writeFileSync(join(root, "ledger.json"), typeof manifest === "string" ? manifest : JSON.stringify(manifest));
  return ledger(["validate"], root);
}

// The tool sorts the problems in one file by message.
const reported = (...messages: readonly string[]) => messages.map((m) => `ledger.json: ${m}`).sort((a, b) => a.localeCompare(b));

const UNSUPPORTED = "a schema using a keyword the validator does not implement, or an implemented one with a value of the wrong shape";
test(`${UNSUPPORTED}, is refused when it loads`, () => {
  const refusals: readonly (readonly [unknown, string])[] = [
    [
      { type: "object", properties: { a: { oneOf: [] } } },
      "schema bad@1.json/properties/a: the keyword oneOf is not one the validator implements",
    ],
    [{ $defs: { a: { exclusiveMaximum: 3 } } }, "schema bad@1.json/$defs/a: the keyword exclusiveMaximum is not one the validator implements"],
    [{ items: { oneOf: [] } }, "schema bad@1.json/items: the keyword oneOf is not one the validator implements"],
    [{ enum: [] }, "schema bad@1.json: enum must be a non-empty list of plain values"],
    [{ enum: [{ a: 1 }] }, "schema bad@1.json: enum must be a non-empty list of plain values"],
    [{ items: "x" }, "schema bad@1.json: items must be an object"],
    [{ minItems: -1 }, "schema bad@1.json: minItems must be a whole number"],
    [{ uniqueItems: false }, "schema bad@1.json: uniqueItems may only be true"],
    [{ type: "float" }, "schema bad@1.json: type must be one of object, string, array, integer, number, boolean"],
    [{ additionalProperties: true }, "schema bad@1.json: additionalProperties may only be false or a schema"],
    [{ additionalProperties: { oneOf: [] } }, "schema bad@1.json/additionalProperties: the keyword oneOf is not one the validator implements"],
    [{ else: {} }, "schema bad@1.json: the keyword else is not one the validator implements"],
    [{ if: "x" }, "schema bad@1.json: if must be an object"],
    [{ then: [] }, "schema bad@1.json: then must be an object"],
    [{ if: { else: {} } }, "schema bad@1.json/if: the keyword else is not one the validator implements"],
    [{ if: { type: "object" }, then: { oneOf: [] } }, "schema bad@1.json/then: the keyword oneOf is not one the validator implements"],
    [{ minimum: 1.5 }, "schema bad@1.json: minimum must be an integer"],
    [{ maximum: 1.5 }, "schema bad@1.json: maximum must be an integer"],
    [{ required: "name" }, "schema bad@1.json: required must be a list of field names"],
    [{ required: [1] }, "schema bad@1.json: required must be a list of field names"],
    [{ properties: [] }, "schema bad@1.json: properties must be an object"],
    [{ $defs: "x" }, "schema bad@1.json: $defs must be an object"],
    [{ minLength: -1 }, "schema bad@1.json: minLength must be a whole number"],
    [{ minLength: 1.5 }, "schema bad@1.json: minLength must be a whole number"],
    [{ pattern: "(" }, "schema bad@1.json: pattern must be a regular expression"],
    [{ pattern: 1 }, "schema bad@1.json: pattern must be a string"],
    [{ $ref: 1 }, "schema bad@1.json: $ref must be a string"],
    [{ title: 1 }, "schema bad@1.json: title must be a string"],
    [{ properties: { a: "not a schema" } }, "schema bad@1.json/properties/a: a schema must be an object"],
    [[], "schema bad@1.json: a schema must be an object"],
    ["{ not json", "schema bad@1.json: not JSON"],
  ];
  for (const [schema, message] of refusals) {
    expect(validate({ "bad@1.json": schema }, {})).toStrictEqual({ code: 1, stdout: "", stderr: `error: ${message}\n` });
  }
});

test("a value that conforms to a schema's if is held to its then as well; one that does not is held to neither", () => {
  const whenInconclusive = { if: { required: ["vote"], properties: { vote: { const: "inconclusive" } } }, then: { required: ["cause"] } };
  const conditional = {
    "ledger@1.json": {
      type: "object",
      properties: {
        schema: { const: "ledger@1" },
        vote: { enum: ["pass", "inconclusive"] },
        cause: { type: "string", minLength: 1 },
        seats: { type: "array", items: { $ref: "#/$defs/seat" } },
      },
      ...whenInconclusive,
      $defs: { seat: { type: "object", ...whenInconclusive } },
    },
  };
  for (const record of [
    { schema: "ledger@1", vote: "inconclusive", cause: "the sandbox vanished" },
    { schema: "ledger@1", vote: "pass" },
    { schema: "ledger@1", cause: "a cause with no vote" },
    { schema: "ledger@1" },
    { schema: "ledger@1", seats: [{ vote: "pass" }, { vote: "inconclusive", cause: "lost" }, {}] },
  ]) {
    expect(validate(conditional, record)).toMatchObject({ code: 0, stdout: "the ledger is valid\n" });
  }
  expect(problems(validate(conditional, { schema: "ledger@1", vote: "inconclusive", seats: [{ vote: "pass" }, { vote: "inconclusive" }] }))).toStrictEqual(
    reported("cause: is required", "seats[1].cause: is required"),
  );
});

test("a ledger whose schema directory is missing fails the run with a message", () => {
  const root = emptyLedger();
  rmSync(join(root, "schema"), { recursive: true });
  const run = ledger(["validate"], root);
  expect(run).toMatchObject({ code: 1, stdout: "" });
  expect(run.stderr).toStartWith("error: cannot read the schemas in ");
});

withoutSuperuser("a ledger whose schema directory cannot be read fails the run with the same message", () => {
  const root = emptyLedger();
  chmodSync(join(root, "schema"), 0);
  try {
    const run = ledger(["validate"], root);
    expect(run).toMatchObject({ code: 1, stdout: "" });
    expect(run.stderr).toStartWith("error: cannot read the schemas in ");
  } finally {
    chmodSync(join(root, "schema"), 0o755);
  }
});

const thing = {
  "defs@1.json": { $defs: { word: { type: "string", minLength: 1, pattern: "^[a-z]+$" } } },
  "ledger@1.json": {
    type: "object",
    required: ["schema", "kind", "name"],
    additionalProperties: false,
    properties: {
      schema: { const: "ledger@1" },
      kind: { const: "thing" },
      name: { $ref: "defs@1.json#/$defs/word" },
      nested: { type: "object", additionalProperties: false, properties: { label: { $ref: "#/$defs/label" } } },
    },
    $defs: { label: { type: "string" } },
  },
};

test("each implemented keyword refuses what it should, through references within and across files", () => {
  expect(validate(thing, { schema: "ledger@1", kind: "thing", name: "alpha", nested: { label: "x" } })).toMatchObject({
    code: 0,
    stdout: "the ledger is valid\n",
  });
  const many = validate(thing, { schema: "ledger@1", kind: "other", name: "Alpha", nested: { label: 1, more: true }, extra: 1 });
  expect(many.code).toBe(1);
  expect(problems(many)).toStrictEqual(
    reported(
      'kind: must be "thing"',
      "name: is not in the required form",
      "nested.label: must be a string",
      "nested.more: is not a field of this record",
      "extra: is not a field of this record",
    ),
  );
  expect(problems(validate(thing, { schema: "ledger@1", name: "", nested: [] }))).toStrictEqual(
    reported("kind: is required", "name: must not be empty", "name: is not in the required form", "nested: must be an object"),
  );
  expect(problems(validate(thing, "[1]"))).toStrictEqual(reported("must be an object"));
});

test("names inherited from Object's prototype are fields like any other: neither a schema nor a value can borrow one", () => {
  // JSON.parse makes __proto__ an own field, as an attacker's record would carry it.
  const record = '{ "schema": "ledger@1", "kind": "thing", "name": "alpha", "__proto__": { "x": 1 }, "toString": "x" }';
  expect(problems(validate(thing, record))).toStrictEqual(
    reported("__proto__: is not a field of this record", "toString: is not a field of this record"),
  );
  // A required field is present only as the record's own field.
  const requires = { "ledger@1.json": { type: "object", required: ["toString"] } };
  expect(problems(validate(requires, { schema: "ledger@1" }))).toStrictEqual(reported("toString: is required"));
  // A definition is found only as the schema's own.
  const borrowing = { "ledger@1.json": { type: "object", properties: { a: { $ref: "#/$defs/constructor" } }, $defs: {} } };
  expect(validate(borrowing, { schema: "ledger@1", a: 1 })).toMatchObject({
    code: 1,
    stderr: "error: schema ledger@1.json: cannot resolve #/$defs/constructor\n",
  });
});

test("a reference to a definition that does not exist is refused when it is followed", () => {
  const missing = { "ledger@1.json": { type: "object", properties: { x: { $ref: "missing@1.json#/$defs/x" } } } };
  expect(validate(missing, { schema: "ledger@1", x: 1 })).toMatchObject({
    code: 1,
    stderr: "error: schema ledger@1.json: cannot resolve missing@1.json#/$defs/x\n",
  });
});

test("references that lead back to themselves, directly or across files, are refused rather than followed forever", () => {
  const direct = { "ledger@1.json": { $ref: "#/$defs/loop", $defs: { loop: { $ref: "#/$defs/loop" } } } };
  expect(validate(direct, { schema: "ledger@1" })).toMatchObject({
    code: 1,
    stderr: "error: schema ledger@1.json: #/$defs/loop leads back to itself\n",
  });
  const across = {
    "ledger@1.json": { $ref: "b@1.json#/$defs/there", $defs: { here: { $ref: "b@1.json#/$defs/there" } } },
    "b@1.json": { $defs: { there: { $ref: "ledger@1.json#/$defs/here" } } },
  };
  const run = validate(across, { schema: "ledger@1" });
  expect(run.code).toBe(1);
  expect(run.stderr).toContain("leads back to itself");
  // A reference reached again through a conditional is the same loop: if and then never step into the value.
  const conditional = { "ledger@1.json": { $ref: "#/$defs/loop", $defs: { loop: { if: {}, then: { $ref: "#/$defs/loop" } } } } };
  expect(validate(conditional, { schema: "ledger@1" })).toMatchObject({
    code: 1,
    stderr: "error: schema ledger@1.json: #/$defs/loop leads back to itself\n",
  });
  // A reference reached again only after stepping into the value is recursion the value ends.
  const node = { type: "object", additionalProperties: false, properties: { schema: {}, child: { $ref: "#/$defs/node" } } };
  const tree = { "ledger@1.json": { $ref: "#/$defs/node", $defs: { node } } };
  expect(validate(tree, { schema: "ledger@1", child: { child: { child: {} } } }).code).toBe(0);
  expect(problems(validate(tree, { schema: "ledger@1", child: { child: { extra: 1 } } }))).toStrictEqual(
    reported("child.child.extra: is not a field of this record"),
  );
});

test("enum and the list keywords refuse what they should, checking each item against its schema", () => {
  const lists = {
    "defs@1.json": { $defs: { word: { type: "string", pattern: "^[a-z]+$" } } },
    "ledger@1.json": {
      type: "object",
      additionalProperties: false,
      properties: {
        schema: { const: "ledger@1" },
        mood: { enum: ["calm", "busy"] },
        tags: { type: "array", minItems: 1, uniqueItems: true, items: { $ref: "defs@1.json#/$defs/word" } },
      },
    },
  };
  expect(validate(lists, { schema: "ledger@1", mood: "calm", tags: ["a", "b"] }).code).toBe(0);
  expect(problems(validate(lists, { schema: "ledger@1", mood: "sad", tags: ["a", "B", "a"] }))).toStrictEqual(
    reported('mood: must be one of "calm", "busy"', "tags: must not repeat an item", "tags[1]: is not in the required form"),
  );
  expect(problems(validate(lists, { schema: "ledger@1", tags: [] }))).toStrictEqual(reported("tags: must have at least 1 item"));
  expect(problems(validate(lists, { schema: "ledger@1", tags: "a" }))).toStrictEqual(reported("tags: must be a list"));
});

test("integer, number, boolean, minimum, maximum, and a schema for the fields a record does not list refuse what they should", () => {
  const typed = {
    "ledger@1.json": {
      type: "object",
      additionalProperties: { type: "integer", minimum: 1 },
      properties: {
        schema: { const: "ledger@1" },
        on: { type: "boolean" },
        share: { type: "number", minimum: 0, maximum: 1 },
        byName: { type: "object", additionalProperties: { type: "object", additionalProperties: false, properties: { n: { type: "integer" } } } },
      },
    },
  };
  expect(validate(typed, { schema: "ledger@1", on: true, share: 0.5, byName: { a: { n: 1 }, b: {} }, count: 2 }).code).toBe(0);
  expect(problems(validate(typed, { schema: "ledger@1", on: "yes", share: 1.5, byName: { a: { n: 1.5, m: 1 } }, count: 0, other: "x" }))).toStrictEqual(
    reported("on: must be true or false", "share: must be at most 1", "byName.a.n: must be a whole number", "byName.a.m: is not a field of this record", "count: must be at least 1", "other: must be a whole number"),
  );
  expect(problems(validate(typed, { schema: "ledger@1", share: "half" }))).toStrictEqual(reported("share: must be a number"));
});
