import type { P2PKOptions } from "@cashu/cashu-ts";
import { SIGFLAG_INPUTS } from "./constants.js";

const PUBKEY_RE = /^0[23][0-9a-f]{64}$/;

export function isCompressedPubkeyHex(s: unknown): s is string {
  return typeof s === "string" && PUBKEY_RE.test(s);
}

/** Section 3.3: deduped, lowercased, sorted ascending, 1-of-N, SIG_INPUTS. */
export function buildLockOptions(allowlist: string[]): P2PKOptions {
  if (allowlist.length === 0) throw new Error("allowlist is empty");
  const keys = [...new Set(allowlist.map((k) => k.toLowerCase()))].sort();
  for (const k of keys) {
    if (!isCompressedPubkeyHex(k)) throw new Error(`invalid compressed secp256k1 pubkey: ${k}`);
  }
  return { pubkey: keys, requiredSignatures: 1, sigFlag: SIGFLAG_INPUTS };
}

interface ParsedLock {
  data: string;
  tags: string[][];
}

function parseLock(secret: string): ParsedLock {
  let json: unknown;
  try {
    json = JSON.parse(secret);
  } catch {
    throw new Error("secret is not JSON");
  }
  if (!Array.isArray(json) || json.length !== 2) throw new Error("secret is not a NUT-10 pair");
  const [kind, body] = json as [unknown, unknown];
  if (kind !== "P2PK") throw new Error("secret kind is not P2PK");
  if (typeof body !== "object" || body === null || Array.isArray(body)) throw new Error("secret body is not an object");
  const { nonce, data, tags } = body as Record<string, unknown>;
  if (typeof nonce !== "string" || nonce.length === 0) throw new Error("missing nonce");
  if (!isCompressedPubkeyHex(typeof data === "string" ? data.toLowerCase() : data)) throw new Error("data is not a compressed pubkey");
  const tagList = tags ?? [];
  if (!Array.isArray(tagList)) throw new Error("tags is not an array");
  for (const t of tagList) {
    if (!Array.isArray(t) || t.length === 0 || !t.every((x) => typeof x === "string")) throw new Error("malformed tag");
  }
  return { data: (data as string).toLowerCase(), tags: tagList as string[][] };
}

function signersOf(lock: ParsedLock): string[] {
  const extra = lock.tags.find((t) => t[0] === "pubkeys")?.slice(1) ?? [];
  return [lock.data, ...extra.map((k) => k.toLowerCase())];
}

/** `data` plus every `pubkeys` tag entry. Throws on a malformed secret. */
export function signerSet(secret: string): string[] {
  return signersOf(parseLock(secret));
}

export type LockValidation = { ok: true; signers: string[] } | { ok: false; reason: string };

/** Section 5.6 check 4: only pubkeys, n_sigs = 1, sigflag = SIG_INPUTS; no locktime, refund or other tags. */
export function validateBlindfoldLock(secret: string): LockValidation {
  let lock: ParsedLock;
  try {
    lock = parseLock(secret);
  } catch (e) {
    return { ok: false, reason: (e as Error).message };
  }
  const seen = new Set<string>();
  for (const tag of lock.tags) {
    const name = tag[0];
    if (name !== "pubkeys" && name !== "n_sigs" && name !== "sigflag") {
      return { ok: false, reason: `tag not allowed: ${name}` };
    }
    if (seen.has(name)) return { ok: false, reason: `duplicate tag: ${name}` };
    seen.add(name);
    if (name === "n_sigs" && !(tag.length === 2 && tag[1] === "1")) return { ok: false, reason: "n_sigs must be 1" };
    if (name === "sigflag" && !(tag.length === 2 && tag[1] === SIGFLAG_INPUTS)) {
      return { ok: false, reason: "sigflag must be SIG_INPUTS" };
    }
    if (name === "pubkeys") {
      if (tag.length < 2) return { ok: false, reason: "pubkeys tag is empty" };
      if (!tag.slice(1).every((k) => isCompressedPubkeyHex(k.toLowerCase()))) {
        return { ok: false, reason: "pubkeys entry is not a compressed pubkey" };
      }
    }
  }
  const signers = signersOf(lock);
  if (new Set(signers).size !== signers.length) return { ok: false, reason: "duplicate signer" };
  return { ok: true, signers };
}
