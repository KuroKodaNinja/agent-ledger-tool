/** A parsed JSON object, keyed by field name. */
export type JsonObject = Readonly<Record<string, unknown>>;

/** Whether `value` is a JSON object: neither null nor an array. */
export function isObject(value: unknown): value is JsonObject {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

// C0 and C1 controls, DEL, and the two Unicode line separators: any of
// them would let text from a record break a line or drive a terminal.
function isUnprintable(code: number): boolean {
  return code < 0x20 || (code >= 0x7f && code <= 0x9f) || code === 0x2028 || code === 0x2029;
}

/** `text` safe to print on one line: each control or line-separator character becomes a `\u` escape. */
export function printable(text: string): string {
  let result = "";
  for (const char of text) {
    const code = char.codePointAt(0) ?? 0;
    result += isUnprintable(code) ? `\\u${code.toString(16).padStart(4, "0")}` : char;
  }
  return result;
}
