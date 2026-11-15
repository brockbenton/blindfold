import type { Context } from "hono";
import type { ZodType } from "zod";
import { MintError } from "../errors.js";

/** Parse a JSON body with zod. Any failure is Cashu code 10000. */
export async function body<T>(c: Context, schema: ZodType<T>): Promise<T> {
  let raw: unknown;
  try {
    raw = await c.req.json();
  } catch {
    throw new MintError(10000, "body is not valid JSON");
  }
  const r = schema.safeParse(raw);
  if (!r.success) throw new MintError(10000, r.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; "));
  return r.data;
}

export async function rawBody(c: Context): Promise<Record<string, unknown>> {
  let raw: unknown;
  try {
    raw = await c.req.json();
  } catch {
    throw new MintError(10000, "body is not valid JSON");
  }
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) throw new MintError(10000, "body must be a JSON object");
  return raw as Record<string, unknown>;
}

export const unixNow = () => Math.floor(Date.now() / 1000);
export const HEX66 = /^0[23][0-9a-fA-F]{64}$/;
export const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
