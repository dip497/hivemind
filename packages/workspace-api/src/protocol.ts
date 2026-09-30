/**
 * The workspace API's messages (`spec/workspace-api.md`). A call names a method and its positional
 * params; the host answers with a result, or with an error that carries a code a client can branch
 * on. Every transport carries these same messages.
 */

/** Why a call failed. */
export type ErrorCode =
  /** The params are not what the method takes, or name something it may not reach (a path outside its repo). */
  | "BAD_REQUEST"
  | "UNKNOWN_METHOD"
  /** It ran and failed: git refused, a file could not be written. */
  | "FAILED";

export interface ErrorBody { code: ErrorCode; message: string }

/** What a host answers a call with. */
export type Answer = { result: unknown } | { error: ErrorBody };

/** What a host sends a client unasked, over the connection the client holds open. */
export interface EventMessage { event: string; params: unknown[] }

/** A call that failed, with its code: what a handler throws to refuse, and what a client throws. */
export class ApiError extends Error {
  constructor(readonly code: ErrorCode, message: string) {
    super(message);
    this.name = "ApiError";
  }
}

// Each method checks its own params with these: a call's params come as they were sent.

/** A param that must be text. */
export function text(value: unknown, name: string): string {
  if (typeof value !== "string" || !value) throw new ApiError("BAD_REQUEST", `${name} must be text`);
  return value;
}

/** A param that is what someone wrote (a file's contents, a note): text, and it may be empty. */
export function written(value: unknown, name: string): string {
  if (typeof value !== "string") throw new ApiError("BAD_REQUEST", `${name} must be text`);
  return value;
}

/** A param checked against a schema (one of core's zod schemas): what it parses to. */
export function shaped<T>(schema: { safeParse(value: unknown): { success: true; data: T } | { success: false; error: { issues: Array<{ path: Array<string | number>; message: string }> } } }, value: unknown, name: string): T {
  const parsed = schema.safeParse(value);
  if (parsed.success) return parsed.data;
  const why = parsed.error.issues.map((i) => `${[name, ...i.path].join(".")}: ${i.message}`).join("; ");
  throw new ApiError("BAD_REQUEST", why);
}

/** A param that must be a whole number, at least `min`. */
export function whole(value: unknown, name: string, min = 0): number {
  if (typeof value !== "number" || !Number.isInteger(value) || value < min) throw new ApiError("BAD_REQUEST", `${name} must be a whole number of at least ${min}`);
  return value;
}

/** A param that must be a list of text. */
export function texts(value: unknown, name: string): string[] {
  if (!Array.isArray(value) || !value.every((v) => typeof v === "string" && v)) throw new ApiError("BAD_REQUEST", `${name} must be a list of text`);
  return value;
}

/** A param that may be left out, and otherwise must be true or false. */
export function flag(value: unknown, name: string): boolean | undefined {
  if (value == null) return undefined;
  if (typeof value !== "boolean") throw new ApiError("BAD_REQUEST", `${name} must be true or false`);
  return value;
}

/** A param that must be one of `values`. */
export function oneOf<T extends string>(value: unknown, name: string, values: readonly T[]): T {
  if (!values.includes(value as T)) throw new ApiError("BAD_REQUEST", `${name} must be one of ${values.join(", ")}`);
  return value as T;
}

/** A param that must be an object: its fields are checked one by one. */
export function fields(value: unknown, name: string): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) throw new ApiError("BAD_REQUEST", `${name} must be an object`);
  return value as Record<string, unknown>;
}
