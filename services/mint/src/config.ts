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
    depositPollMs: Number(env.DEPOSIT_POLL_MS ?? DEPOSIT_POLL_MS),
    settleIntervalS: Number(env.SETTLE_INTERVAL_S ?? SETTLE_INTERVAL_S),
    settleHoldS: Number(env.SETTLE_HOLD_S ?? env.SETTLE_INTERVAL_S ?? SETTLE_HOLD_S),
    settleUnitCents: Number(env.SETTLE_UNIT_CENTS ?? SETTLE_UNIT_CENTS),
    devFakeChain: env.MINT_DEV_FAKE_CHAIN === "1",
  };
}

export function loadKeypair(path: string): Keypair {
  return Keypair.fromSecretKey(Uint8Array.from(JSON.parse(readFileSync(path, "utf8")) as number[]));
}
