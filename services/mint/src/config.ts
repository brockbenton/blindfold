import { readFileSync } from "node:fs";
import { Keypair } from "@solana/web3.js";
import { DEPOSIT_POLL_MS, SETTLE_HOLD_S, SETTLE_INTERVAL_S, SETTLE_UNIT_CENTS, loadMintEnv, type Env } from "@blindfold/protocol";
import { z } from "zod";

export type MintEnv = ReturnType<typeof loadMintEnv>;

export interface ProviderMeta {
  provider_id: number;
  name: string;
  url: string | null;
  price_cents: number | null;
  topics: string[];
}

const providersFile = z.array(
  z.object({
    provider_id: z.number().int().min(0),
    name: z.string(),
    url: z.string().nullish().transform((v) => v ?? null),
    price_cents: z.number().int().nullish().transform((v) => v ?? null),
    topics: z.array(z.string()).optional().transform((v) => v ?? []),
  }),
);

export function loadProvidersFile(path: string): ProviderMeta[] {
  return providersFile.parse(JSON.parse(readFileSync(path, "utf8")));
}

export interface AppConfig extends MintEnv {
  providers: ProviderMeta[];
  depositPollMs: number;
  settleIntervalS: number;
  /** Payout policy (02-mint.md, Settlement privacy). Omitted in-process: 0 and 1, i.e. pay every balance in full now. */
  settleHoldS?: number;
  settleUnitCents?: number;
  /** Dev only: in-memory vault and fake settlement sender, plus /dev/* hooks. */
  devFakeChain: boolean;
}

export function loadConfig(env: Env = process.env): AppConfig {
  const e = loadMintEnv(env);
  const file = env.PROVIDERS_FILE ?? new URL("../../../config/providers.json", import.meta.url).pathname;
  return {
    ...e,
    providers: loadProvidersFile(file),
    depositPollMs: num(env, "DEPOSIT_POLL_MS", DEPOSIT_POLL_MS, 1),
    settleIntervalS: num(env, "SETTLE_INTERVAL_S", SETTLE_INTERVAL_S, 1),
    settleHoldS: num(env, "SETTLE_HOLD_S", Number(env.SETTLE_INTERVAL_S ?? SETTLE_HOLD_S), 0),
    settleUnitCents: num(env, "SETTLE_UNIT_CENTS", SETTLE_UNIT_CENTS, 1),
    devFakeChain: env.MINT_DEV_FAKE_CHAIN === "1",
  };
}

/** A whole-number setting at or above `min`; a typo fails at boot instead of breaking every timer run. */
function num(env: Env, key: string, fallback: number, min: number): number {
  const v = env[key] === undefined || env[key] === "" ? fallback : Number(env[key]);
  if (!Number.isInteger(v) || v < min) throw new Error(`${key} must be an integer >= ${min}, got ${env[key]}`);
  return v;
}

export function loadKeypair(path: string): Keypair {
  return Keypair.fromSecretKey(Uint8Array.from(JSON.parse(readFileSync(path, "utf8")) as number[]));
}
