#!/usr/bin/env node
import { readFileSync } from "node:fs";
import { pathToFileURL } from "node:url";
import { Keypair, PublicKey } from "@solana/web3.js";
import { Command } from "commander";
import { loadOwnerEnv, loadWalletEnv } from "@blindfold/protocol";
import { SolanaDepositor, type Depositor } from "./depositor.js";
import { fetchProviders, ownerBalance, ownerFund, ownerResume } from "./owner.js";

export interface CliDeps {
  out?: (line: string) => void;
  /** Tests inject a fake; the real CLI builds a SolanaDepositor from OWNER_KEYPAIR. */
  makeDepositor?: () => Depositor;
  env?: Record<string, string | undefined>;
  stateDir?: string;
  pollMs?: number;
}

function solanaDepositor(env: Record<string, string | undefined>): Depositor {
  const e = loadOwnerEnv(env);
  const owner = Keypair.fromSecretKey(Uint8Array.from(JSON.parse(readFileSync(e.OWNER_KEYPAIR, "utf8")) as number[]));
  return new SolanaDepositor({
    rpcUrl: e.SOLANA_RPC_URL, owner, programId: new PublicKey(e.VAULT_PROGRAM_ID), usdcMint: new PublicKey(e.USDC_MINT),
  });
}

export async function runCli(argv: string[], deps: CliDeps = {}): Promise<void> {
  const out = deps.out ?? ((l: string) => console.log(l));
  const env = deps.env ?? process.env;
  const mintUrl = () => loadWalletEnv(env).MINT_URL;
  const tokenFileOf = (v?: string) => v ?? loadWalletEnv(env).TOKEN_FILE;
  const depositor = () => (deps.makeDepositor ?? (() => solanaDepositor(env)))();

  const program = new Command("owner").exitOverride().configureOutput({ writeOut: out, writeErr: () => undefined });

  program.command("fund").description("quote, deposit, mint locked tokens, write the token file")
    .requiredOption("--cents <n>", "amount in cents", (v) => Number.parseInt(v, 10))
    .option("--prices <list>", "expected provider prices in cents, comma separated")
    .option("--token-file <path>")
    .action(async (o: { cents: number; prices?: string; tokenFile?: string }) => {
      const tokenFile = tokenFileOf(o.tokenFile);
      const prices = o.prices ? Object.fromEntries(o.prices.split(",").map((p, i) => [i, Number.parseInt(p, 10)])) : undefined;
      const r = await ownerFund({
        mintUrl: mintUrl(), cents: o.cents, prices, tokenFile, depositor: depositor(),
        stateDir: deps.stateDir, pollMs: deps.pollMs, onProgress: (s) => out(`step ${s}`),
      });
      const b = await ownerBalance(tokenFile);
      out(`quote ${r.quote}`);
      out(`deposit ${r.depositTx}`);
      out(`balance ${b.spendable}c in ${r.proofs} new proofs`);
    });

  program.command("resume <quote-pubkey>").description("resume an interrupted fund")
    .action(async (pk: string) => {
      const r = await ownerResume(pk, { depositor: depositor(), stateDir: deps.stateDir, pollMs: deps.pollMs });
      out(`quote ${r.quote}`);
      out(`deposit ${r.depositTx}`);
      out(`proofs ${r.proofs}`);
    });

  program.command("balance").option("--token-file <path>")
    .action(async (o: { tokenFile?: string }) => {
      const b = await ownerBalance(tokenFileOf(o.tokenFile));
      out(`spendable ${b.spendable}c`);
      out(`pending ${b.pending}c`);
      out(`denominations ${Object.entries(b.byDenom).map(([d, n]) => `${d}x${n}`).join(" ") || "none"}`);
    });

  program.command("providers").description("list providers known to the mint")
    .action(async () => {
      for (const p of await fetchProviders(mintUrl())) {
        out(`${p.provider_id}\t${p.active ? "active" : "inactive"}\t${p.name ?? "-"}\t${p.url ?? "-"}\t${p.price_cents ?? "-"}c\t${p.pubkey}`);
      }
    });

  await program.parseAsync(argv, { from: "user" });
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  runCli(process.argv.slice(2)).catch((e: Error & { code?: string }) => {
    if (e.code === "commander.helpDisplayed" || e.code === "commander.version") process.exit(0);
    console.error(`error: ${e.message}`);
    process.exit(1);
  });
}
