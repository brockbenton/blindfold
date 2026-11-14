// Shared helpers for the devnet scripts. Devnet only: refuses mainnet RPC URLs.
import { readFileSync } from "node:fs";
import { Connection, Keypair, PublicKey, sendAndConfirmTransaction, Transaction, type TransactionInstruction } from "@solana/web3.js";
import { DEFAULT_VAULT_PROGRAM_ID, SOLANA_COMMITMENT, USDC_DEVNET_MINT } from "@blindfold/protocol";

export function loadKeypair(path: string): Keypair {
  return Keypair.fromSecretKey(Uint8Array.from(JSON.parse(readFileSync(path, "utf8")) as number[]));
}

export function loadEnv() {
  const rpc = process.env.SOLANA_RPC_URL ?? "https://api.devnet.solana.com";
  if (/mainnet/i.test(rpc)) throw new Error("refusing to run against mainnet");
  const adminPath = process.env.ADMIN_KEYPAIR;
  if (!adminPath) throw new Error("ADMIN_KEYPAIR (path to keypair json) is required");
  return {
    connection: new Connection(rpc, SOLANA_COMMITMENT),
    programId: new PublicKey(process.env.VAULT_PROGRAM_ID ?? DEFAULT_VAULT_PROGRAM_ID),
    usdcMint: new PublicKey(process.env.USDC_MINT ?? USDC_DEVNET_MINT),
    admin: loadKeypair(adminPath),
  };
}

export async function send(connection: Connection, ixs: TransactionInstruction[], signers: Keypair[]): Promise<string> {
  const tx = new Transaction().add(...ixs);
  return sendAndConfirmTransaction(connection, tx, signers, { commitment: SOLANA_COMMITMENT });
}
