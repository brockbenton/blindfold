#!/usr/bin/env node
import { parseArgs } from "node:util";
import { pathToFileURL } from "node:url";
import { Connection, PublicKey } from "@solana/web3.js";
import { PaymentFailed, PaymentRefused, AgentWallet } from "@blindfold/wallet";
import { DEFAULT_MINT_URL } from "@blindfold/protocol";
import { ConfigError, HttpError, NetworkError, NoProviderError, ReservesFailedError } from "./errors.js";
import { humanReporter, jsonReporter, type ErrorReport, type Reporter } from "./reporter.js";
import { runScripted } from "./scripted.js";
import { fakeProviders, fakeReserves, fakeWallet } from "./stubs.js";
import { makeTools, type Tools, type WalletLike } from "./tools.js";

export interface Io {
  stdout: (s: string) => void;
  stderr: (s: string) => void;
}

export function classify(e: unknown): { exit: number; report: ErrorReport } {
  const message = (e as Error)?.message ?? String(e);
  if (e instanceof ConfigError) return { exit: 2, report: { kind: "config", message } };
  if (e instanceof PaymentRefused) return { exit: 3, report: { kind: "payment_refused", message, reason: e.reason } };
  if (e instanceof ReservesFailedError) return { exit: 7, report: { kind: "reserves_failed", message, reason: e.reason } };
  if (e instanceof NoProviderError) return { exit: 6, report: { kind: "no_provider", message } };
  if (e instanceof HttpError) return { exit: 5, report: { kind: "http", message, status: e.status } };
  if (e instanceof PaymentFailed) return { exit: 5, report: { kind: "http", message, status: e.status } };
  if (e instanceof NetworkError || (e instanceof TypeError && (/fetch failed|terminated/.test(message) || (e as { cause?: unknown }).cause))) {
    return { exit: 4, report: { kind: "network", message } };
  }
  return { exit: 1, report: { kind: "internal", message } };
}

/** Returns the exit code. `overrides.tools` lets tests inject tools. */
export async function runMain(
  argv: string[],
  env: Record<string, string | undefined>,
  io: Io,
  overrides: { tools?: Tools; connection?: Connection } = {},
): Promise<number> {
  let out: Reporter = humanReporter(io);
  let opened: AgentWallet | undefined;
  try {
    let a;
    try {
      a = parseArgs({
        args: argv,
        options: {
          "token-file": { type: "string" }, "mint-url": { type: "string" }, "max-per-call": { type: "string" },
          topic: { type: "string" }, provider: { type: "string" }, calls: { type: "string" },
          json: { type: "boolean" }, fake: { type: "boolean" },
        },
      }).values;
    } catch (e) {
      throw new ConfigError((e as Error).message);
    }
    if (a.json) out = jsonReporter(io);
    const fake = a.fake === true || env.AGENT_FAKE === "1";
    const int = (v: string | undefined, def: number, name: string) => {
      const n = v === undefined ? def : Number(v);
      if (!Number.isInteger(n) || n < 1) throw new ConfigError(`${name} must be a positive integer`);
      return n;
    };
    const calls = int(a.calls, 1, "--calls");
    const reserveEvery = int(env.RESERVE_CHECK_EVERY, 10, "RESERVE_CHECK_EVERY");
    const mintUrl = a["mint-url"] ?? env.MINT_URL ?? DEFAULT_MINT_URL;
    const maxPerCall = int(a["max-per-call"] ?? env.MAX_PER_CALL_CENTS, 10, "max per call");

    let tools = overrides.tools;
    if (!tools) {
      if (fake) {
        const wallet: WalletLike = fakeWallet(
          Number(env.FAKE_START_CENTS ?? 100), Number(env.FAKE_PRICE_CENTS ?? 5), maxPerCall, env,
        );
        tools = makeTools({
          wallet, mintUrl, out, connection: undefined as never, programId: undefined as never, usdcMint: undefined as never,
          listProviders: async () => fakeProviders, checkReserves: fakeReserves(env),
        });
      } else {
        const tokenFile = a["token-file"] ?? env.TOKEN_FILE;
        if (!tokenFile) throw new ConfigError("TOKEN_FILE or --token-file is required");
        for (const k of ["SOLANA_RPC_URL", "VAULT_PROGRAM_ID", "USDC_MINT"]) {
          if (!env[k]) throw new ConfigError(`${k} is required`);
        }
        let programId: PublicKey, usdcMint: PublicKey;
        try {
          programId = new PublicKey(env.VAULT_PROGRAM_ID!);
          usdcMint = new PublicKey(env.USDC_MINT!);
        } catch (e) {
          throw new ConfigError(`bad public key in env: ${(e as Error).message}`);
        }
        const allow = (env.WALLET_ALLOWLIST ?? "").split(",").map((s) => s.trim().toLowerCase()).filter(Boolean);
        let wallet: AgentWallet;
        try {
          wallet = await AgentWallet.open({ tokenFile, maxPerCallCents: maxPerCall, allowlist: allow.length ? allow : undefined, usdcMint: env.USDC_MINT });
        } catch (e) {
          throw new ConfigError(`cannot open token file: ${(e as Error).message}`);
        }
        opened = wallet;
        tools = makeTools({ wallet, mintUrl, out, connection: overrides.connection ?? new Connection(env.SOLANA_RPC_URL!, "confirmed"), programId, usdcMint });
      }
    }
    const result = await runScripted(tools, { topic: a.topic ?? "sol", provider: a.provider, calls, reserveEvery });
    out.result(result);
    return 0;
  } catch (e) {
    const { exit, report } = classify(e);
    out.error(report);
    return exit;
  } finally {
    opened?.close();
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  runMain(process.argv.slice(2), process.env, { stdout: (s) => process.stdout.write(s), stderr: (s) => process.stderr.write(s) })
    .then((code) => process.exit(code));
}
