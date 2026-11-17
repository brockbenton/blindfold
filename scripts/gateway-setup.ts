// One-time devnet setup for the Blindfold gateway (apps/gateway, docs/design/06-gateway.md):
//   - creates the gateway's provider key (.keys/gateway-secret.hex) and shared wallet (.keys/gateway-wallet.json)
//   - registers the gateway as a vault provider, paid out to the gateway wallet's own USDC account, so settlement
//     refills the wallet that buys upstream (deployer.json must be the vault admin)
//   - tops the wallet up with devnet USDC from owner.json when it runs low
// Usage: pnpm gateway:setup [--url http://localhost:4100] [--min-cents 25] [--top-up-cents 50]
import { randomBytes } from "node:crypto";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { getPubKeyFromPrivKey } from "@cashu/cashu-ts";
import { createTransferCheckedInstruction, getAssociatedTokenAddressSync, getOrCreateAssociatedTokenAccount } from "@solana/spl-token";
import { Connection, Keypair, PublicKey, sendAndConfirmTransaction, Transaction, type TransactionInstruction } from "@solana/web3.js";
import {
  DEFAULT_VAULT_PROGRAM_ID, SOLANA_COMMITMENT, USDC_DEVNET_MINT, buildRegisterProviderIx, centsToBaseUnits, configPda,
  decodeConfig, decodeProviderRecord, providerPda,
} from "@blindfold/protocol";
import { loadOrCreateKeypair } from "../apps/gateway/src/wallet.js";

const ROOT = fileURLToPath(new URL("..", import.meta.url));
const KEYS = join(ROOT, ".keys");
const arg = (name: string, dflt: string) => {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : dflt;
};
const url = arg("url", "http://localhost:4100");
const minCents = Number(arg("min-cents", "25"));
const topUpCents = Number(arg("top-up-cents", "50"));

const rpc = process.env.SOLANA_RPC_URL ?? "https://api.devnet.solana.com";
if (/mainnet/i.test(rpc)) throw new Error("devnet only: refusing a mainnet RPC URL");
const connection = new Connection(rpc, SOLANA_COMMITMENT);
const programId = new PublicKey(process.env.VAULT_PROGRAM_ID ?? DEFAULT_VAULT_PROGRAM_ID);
const usdcMint = new PublicKey(process.env.USDC_MINT ?? USDC_DEVNET_MINT);
const keypair = (name: string) => Keypair.fromSecretKey(Uint8Array.from(JSON.parse(readFileSync(join(KEYS, `${name}.json`), "utf8")) as number[]));
const send = (ixs: TransactionInstruction[], signers: Keypair[]) =>
  sendAndConfirmTransaction(connection, new Transaction().add(...ixs), signers, { commitment: SOLANA_COMMITMENT });
const hex = (b: Uint8Array) => Buffer.from(b).toString("hex");
const usd = (base: bigint) => `$${(Number(base) / 1e6).toFixed(2)}`;

// Keys.
const secretPath = join(KEYS, "gateway-secret.hex");
if (!existsSync(secretPath)) {
  writeFileSync(secretPath, hex(randomBytes(32)), { mode: 0o600 });
  console.log(`created ${secretPath}; add it to your key backup`);
}
const secret = readFileSync(secretPath, "utf8").trim();
const pubkey = hex(getPubKeyFromPrivKey(Buffer.from(secret, "hex")));
const walletPath = join(KEYS, "gateway-wallet.json");
const { bytes, created } = loadOrCreateKeypair(walletPath, true);
if (created) console.log(`created ${walletPath}; add it to your key backup`);
const wallet = Keypair.fromSecretKey(bytes);
const walletAta = getAssociatedTokenAddressSync(usdcMint, wallet.publicKey);
const admin = keypair("deployer");

// The wallet's USDC account: the source of upstream payments and the vault payout destination.
await getOrCreateAssociatedTokenAccount(connection, admin, usdcMint, wallet.publicKey);

// Vault registration (once).
const cfgInfo = await connection.getAccountInfo(configPda(programId));
if (!cfgInfo) throw new Error(`vault ${programId.toBase58()} is not initialized`);
const config = decodeConfig(cfgInfo.data);
let providerId: number | null = null;
for (let id = 0; id < config.providerCount; id++) {
  const info = await connection.getAccountInfo(providerPda(id, programId));
  if (!info) continue;
  const rec = decodeProviderRecord(info.data);
  if (rec.active && hex(rec.cashuPubkey) === pubkey) {
    if (!rec.payoutToken.equals(walletAta)) throw new Error(`provider ${id} uses this key but pays out to ${rec.payoutToken.toBase58()}, not the gateway wallet`);
    providerId = id;
  }
}
if (providerId === null) {
  if (!config.admin.equals(admin.publicKey)) throw new Error("the gateway is not registered and deployer.json is not the vault admin");
  providerId = config.providerCount;
  const tx = await send([buildRegisterProviderIx({ programId, admin: admin.publicKey, providerId, cashuPubkey: pubkey, payoutToken: walletAta })], [admin]);
  console.log(`registered the gateway as vault provider ${providerId}: ${tx}`);
} else {
  console.log(`the gateway is vault provider ${providerId}`);
}

// Working balance for upstream purchases.
const balance = async (ata: PublicKey) => BigInt((await connection.getTokenAccountBalance(ata, SOLANA_COMMITMENT).catch(() => ({ value: { amount: "0" } }))).value.amount);
let have = await balance(walletAta);
if (have < centsToBaseUnits(minCents)) {
  const owner = keypair("owner");
  const ownerAta = getAssociatedTokenAddressSync(usdcMint, owner.publicKey);
  const amount = centsToBaseUnits(topUpCents);
  if ((await balance(ownerAta)) < amount) throw new Error(`gateway wallet holds ${usd(have)}; owner ${owner.publicKey.toBase58()} cannot top it up (faucet.circle.com)`);
  const tx = await send([createTransferCheckedInstruction(ownerAta, usdcMint, walletAta, owner.publicKey, amount, 6)], [owner]);
  console.log(`sent ${usd(amount)} from the owner to the gateway wallet: ${tx}`);
  have = await balance(walletAta);
}

console.log(JSON.stringify({
  provider_id: providerId, pubkey, wallet: wallet.publicKey.toBase58(), wallet_usdc: usd(have),
  // Add this entry to the mint's PROVIDERS_FILE so agents discover the gateway.
  providers_entry: { provider_id: providerId, name: "Gateway", url, price_cents: 5, topics: ["sol", "btc", "eth"] },
}, null, 2));
