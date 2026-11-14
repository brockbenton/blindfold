// Shared test helpers: an in-memory keyset, locked token issuance, and a fake mint redeem (00 section 5.6).
import {
  Amount, OutputData, createBlindSignature, createDLEQProof, createNewMintKeys, createRandomSecretKey,
  getP2PKWitnessSignatures, getPubKeyFromPrivKey, getValidSigners, hashToCurve, pointFromHex, signP2PKProofs,
  verifyUnblindedSignature, type Proof,
} from "@cashu/cashu-ts";
import {
  CashuErrorCode, BlindfoldErrorCode, MAX_REDEEM_PROOFS, buildLockOptions, fromWireProof,
  validateBlindfoldLock, type WireProof,
} from "@blindfold/protocol";

const hex = (b: Uint8Array) => Buffer.from(b).toString("hex");
const utf8 = (s: string) => new TextEncoder().encode(s);

export interface TestKeyset {
  id: string;
  /** amount (string) to compressed pubkey hex, usable as cashu-ts keys. */
  keys: Record<string, string>;
  /** amount (string) to private key. Never leaves tests. */
  privKeys: Record<string, Uint8Array>;
}

/** Deterministic for a given seed. A number seed fills 32 bytes with that byte. */
export function createTestKeyset(seed: number | Uint8Array = 7): TestKeyset {
  const s = typeof seed === "number" ? new Uint8Array(32).fill(seed) : seed;
  const kp = createNewMintKeys(13, s, { unit: "usd" });
  const keys = Object.fromEntries(Object.entries(kp.pubKeys).map(([a, k]) => [a, hex(k)]));
  return { id: kp.keysetId, keys, privKeys: kp.privKeys };
}

/** Blind-sign outputs and unblind them into proofs (what mint + owner do at issuance). */
function signOutputs(keyset: TestKeyset, outputs: OutputData[]): Proof[] {
  return outputs.map((od) => {
    const bm = od.blindedMessage;
    const priv = keyset.privKeys[String(bm.amount)];
    const B_ = pointFromHex(bm.B_);
    const { C_ } = createBlindSignature(B_, priv, bm.id);
    const d = createDLEQProof(B_, priv);
    const sig = { id: bm.id, amount: bm.amount, C_: C_.toHex(true), dleq: { s: hex(d.s), e: hex(d.e) } };
    return od.toProof(sig as never, keyset);
  });
}

/** Proofs locked with the Blindfold lock over `allowlist`. `amounts` is the exact denomination split. */
export function issueLockedProofs(o: { keyset: TestKeyset; allowlist: string[]; amounts: number[] }): Proof[] {
  const total = o.amounts.reduce((a, b) => a + b, 0);
  const outputs = OutputData.createP2PKData(buildLockOptions(o.allowlist), total, o.keyset, o.amounts);
  return signOutputs(o.keyset, outputs);
}

export function makeProviderKey(): { sk: string; pubkey: string } {
  const sk = createRandomSecretKey();
  return { sk: hex(sk), pubkey: hex(getPubKeyFromPrivKey(sk)) };
}

/** Add the provider's NUT-11 signature as witness, like the provider's settle step. */
export function signAsProvider(proofs: Proof[], sk: string): Proof[] {
  return signP2PKProofs(proofs, sk);
}

export type RedeemResult =
  | { ok: true; provider_id: number; amount: number; redemption_id: string }
  | { ok: false; code: number; detail: string };

/**
 * In-memory mint redeem implementing section 5.6 checks 1-8.
 * `registeredPubkeys`: an array (provider ids by index) or a map pubkey to provider id. Active providers only.
 */
export function fakeRedeem(keyset: TestKeyset, registeredPubkeys: string[] | Map<string, number>) {
  const providers = Array.isArray(registeredPubkeys)
    ? new Map(registeredPubkeys.map((k, i) => [k.toLowerCase(), i]))
    : registeredPubkeys;
  const spent = new Set<string>();
  const balances = new Map<number, number>();
  const fail = (code: number, detail: string): RedeemResult => ({ ok: false, code, detail });

  function redeem(input: (Proof | WireProof)[]): RedeemResult {
    if (input.length < 1 || input.length > MAX_REDEEM_PROOFS) return fail(CashuErrorCode.TOO_MANY_INPUTS, "bad proof count");
    const proofs: Proof[] = input.map((p) => (typeof p.amount === "object" ? (p as Proof) : fromWireProof(p as WireProof)));
    if (new Set(proofs.map((p) => p.secret)).size !== proofs.length) return fail(CashuErrorCode.DUPLICATE_INPUTS, "duplicate secret");
    let signer: string | undefined;
    const Ys: string[] = [];
    let amount = 0;
    for (const p of proofs) {
      const amt = p.amount.toString();
      const priv = keyset.privKeys[amt];
      if (p.id !== keyset.id || !priv) return fail(CashuErrorCode.KEYSET_NOT_FOUND, "unknown keyset or amount");
      let validC = false;
      try {
        validC = verifyUnblindedSignature({ C: pointFromHex(p.C), secret: utf8(p.secret), id: p.id }, priv);
      } catch { /* invalid point */ }
      if (!validC) return fail(CashuErrorCode.TOKEN_NOT_VERIFIED, "bad C");
      const lock = validateBlindfoldLock(p.secret);
      if (!lock.ok) return fail(BlindfoldErrorCode.INVALID_LOCK, lock.reason);
      let valid: string[] = [];
      try {
        const sigs = p.witness ? getP2PKWitnessSignatures(p.witness as never) : [];
        valid = getValidSigners(sigs, p.secret, lock.signers);
      } catch { /* malformed witness: zero valid signers */ }
      if (valid.length !== 1) return fail(CashuErrorCode.TOKEN_NOT_VERIFIED, `valid signers: ${valid.length}`);
      const key = valid[0].toLowerCase();
      if (!providers.has(key)) return fail(BlindfoldErrorCode.PROVIDER_NOT_REGISTERED, "signer not registered");
      if (signer && signer !== key) return fail(BlindfoldErrorCode.MIXED_PROVIDERS, "mixed signers");
      signer = key;
      Ys.push(hashToCurve(utf8(p.secret)).toHex(true));
      amount += Amount.from(p.amount).toNumber();
    }
    // One "DB transaction": all or nothing.
    if (Ys.some((y) => spent.has(y))) return fail(CashuErrorCode.PROOF_ALREADY_SPENT, "already spent");
    Ys.forEach((y) => spent.add(y));
    const provider_id = providers.get(signer!)!;
    balances.set(provider_id, (balances.get(provider_id) ?? 0) + amount);
    return { ok: true, provider_id, amount, redemption_id: crypto.randomUUID() };
  }

  return { redeem, spent, balances };
}
