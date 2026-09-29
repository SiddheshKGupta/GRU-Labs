// Canonical JSON and content addressing.
//
// Every digest in GRU is computed over this encoding, so it is written out
// by hand rather than trusting JSON.stringify's key order: integer-like keys
// enumerate numerically in JavaScript, which a verifier in another language
// would not reproduce. Values JSON cannot represent are an error, never
// silently dropped -- an `undefined` that vanished from a record is a field
// the digest no longer covers.

import { createHash } from "node:crypto";

export type Json = null | boolean | number | string | Json[] | { [key: string]: Json };

export class CanonicalError extends Error {
  override name = "CanonicalError";
}

function write(value: unknown, at: string): string {
  if (value === null) return "null";
  switch (typeof value) {
    case "boolean":
      return value ? "true" : "false";
    case "number":
      if (!Number.isFinite(value)) throw new CanonicalError(`${at}: non-finite number`);
      return JSON.stringify(value);
    case "string":
      return JSON.stringify(value);
    case "object": {
      if (Array.isArray(value)) {
        return `[${value.map((item, index) => write(item, `${at}[${index}]`)).join(",")}]`;
      }
      const prototype = Object.getPrototypeOf(value);
      if (prototype !== Object.prototype && prototype !== null) {
        throw new CanonicalError(`${at}: not a plain object`);
      }
      const record = value as Record<string, unknown>;
      const keys = Object.keys(record).sort();
      const parts: string[] = [];
      for (const key of keys) {
        if (record[key] === undefined) throw new CanonicalError(`${at}.${key}: undefined`);
        parts.push(`${JSON.stringify(key)}:${write(record[key], `${at}.${key}`)}`);
      }
      return `{${parts.join(",")}}`;
    }
    default:
      throw new CanonicalError(`${at}: ${typeof value} is not JSON`);
  }
}

export function canonical(value: unknown): string {
  return write(value, "$");
}

export function sha256(data: string | Uint8Array): string {
  return createHash("sha256").update(data).digest("hex");
}

export function digestOf(value: unknown): string {
  return sha256(canonical(value));
}

/** A JSON-safe deep copy that also proves the value is canonicalisable. */
export function toJson(value: unknown): Json {
  return JSON.parse(canonical(value)) as Json;
}
