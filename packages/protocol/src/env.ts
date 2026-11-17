import { z } from "zod";
import { DEFAULT_MINT_URL, USDC_DEVNET_MINT } from "./constants.js";
import { PLACEHOLDER_VAULT_PROGRAM_ID } from "./idl.js";
import { isCompressedPubkeyHex } from "./lock.js";

export type Env = Record<string, string | undefined>;

const b58 = z.string().regex(/^[1-9A-HJ-NP-Za-km-z]{32,44}$/, "expected a base58 public key");
const hex32 = z.string().regex(/^[0-9a-fA-F]{64}$/, "expected 32 bytes of hex");
const url = z.string().url();
const int = (def: number, min = 0) => z.coerce.number().int().min(min).default(def);
const nonEmpty = z.string().min(1);

const solana = {
  SOLANA_RPC_URL: url.default("https://api.devnet.solana.com"),
  VAULT_PROGRAM_ID: b58.default(PLACEHOLDER_VAULT_PROGRAM_ID),
  USDC_MINT: b58.default(USDC_DEVNET_MINT),
};
const mintUrl = { MINT_URL: url.default(DEFAULT_MINT_URL) };

const parse = <T extends z.ZodRawShape>(shape: T, env: Env): z.infer<z.ZodObject<T>> => {
  const r = z.object(shape).safeParse(env);
  if (!r.success) {
    const msg = r.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; ");
    throw new Error(`invalid environment: ${msg}`);
  }
  return r.data;
};

export function loadMintEnv(env: Env = process.env) {
  return parse({
    ...solana,
    ...mintUrl,
    DATABASE_URL: nonEmpty,
    MINT_SEED: hex32,
    MINT_AUTHORITY_KEYPAIR: nonEmpty,
    MINT_ADMIN_TOKEN: nonEmpty,
    PORT: int(3338, 1),
  }, env);
}

export function loadMockApiEnv(env: Env = process.env) {
  const e = parse({
    MINT_URL: mintUrl.MINT_URL,
    USDC_MINT: solana.USDC_MINT,
    PROVIDER_SECRET_KEY: hex32,
    PROVIDER_ID: int(0),
    PRICE_CENTS: int(5, 1),
    PORT: int(4000, 1),
    PUBLIC_URL: url.optional(),
  }, env);
  return { ...e, PUBLIC_URL: e.PUBLIC_URL ?? `http://localhost:${e.PORT}` };
}

const pubkeyList = z
  .string()
  .default("")
  .transform((s) => s.split(",").map((x) => x.trim().toLowerCase()).filter(Boolean))
  .refine((l) => l.every(isCompressedPubkeyHex), "WALLET_ALLOWLIST entries must be compressed pubkeys");

export function loadWalletEnv(env: Env = process.env) {
  return parse({
    MINT_URL: mintUrl.MINT_URL,
    USDC_MINT: solana.USDC_MINT,
    TOKEN_FILE: nonEmpty.default("./tokens.json"),
    MAX_PER_CALL_CENTS: int(10, 1),
    APPROVAL_OVER_CENTS: int(20, 0),
    WALLET_ALLOWLIST: pubkeyList,
  }, env);
}

/** Agent: wallet settings plus the Solana reads for the reserve check (section 7.6). */
export function loadAgentEnv(env: Env = process.env) {
  return { ...loadWalletEnv(env), ...parse({ ...solana, RESERVE_CHECK_EVERY: int(10, 1) }, env) };
}

export function loadOwnerEnv(env: Env = process.env) {
  return parse({ ...solana, ...mintUrl, OWNER_KEYPAIR: nonEmpty }, env);
}

export function loadScriptsEnv(env: Env = process.env) {
  return parse({ ...solana, ...mintUrl, ADMIN_KEYPAIR: nonEmpty }, env);
}
