import { serve } from "@hono/node-server";
import { Connection, PublicKey } from "@solana/web3.js";
import { SOLANA_COMMITMENT } from "@blindfold/protocol";
import { FakeSender, MemoryVault } from "./chain/memory.js";
import { SolanaSettleSender } from "./chain/settleSender.js";
import { SolanaVaultReader } from "./chain/vaultReader.js";
import { loadConfig, loadKeypair } from "./config.js";
import { createPool } from "./db.js";
import { createMint } from "./mint.js";

const cfg = loadConfig();
const db = createPool(cfg.DATABASE_URL);

let vault, sender, devVault: MemoryVault | undefined;
if (cfg.devFakeChain) {
  console.warn("MINT_DEV_FAKE_CHAIN=1: in-memory vault and fake settlement sender, /dev/* hooks enabled. Never use in production.");
  devVault = new MemoryVault();
  vault = devVault;
  sender = new FakeSender(devVault);
} else {
  const connection = new Connection(cfg.SOLANA_RPC_URL, SOLANA_COMMITMENT);
  const programId = new PublicKey(cfg.VAULT_PROGRAM_ID);
  const usdc = new PublicKey(cfg.USDC_MINT);
  vault = new SolanaVaultReader(connection, programId, usdc);
  sender = new SolanaSettleSender(connection, programId, usdc, loadKeypair(cfg.MINT_AUTHORITY_KEYPAIR));
}

const { app, ctx, start } = await createMint({ db, cfg, vault, sender, devVault });
start();
serve({ fetch: app.fetch, port: cfg.PORT }, (i) => console.log(`mint listening on :${i.port}, keyset ${ctx.keysets.activeId}`));
