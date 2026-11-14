// Initialize the vault (idempotent: skips if Config exists).
// env: ADMIN_KEYPAIR, MINT_AUTHORITY (pubkey, default = admin), SOLANA_RPC_URL, VAULT_PROGRAM_ID, USDC_MINT
import { PublicKey } from "@solana/web3.js";
import { MAX_DEPOSIT_CENTS, buildInitializeIx, centsToBaseUnits, configPda, decodeConfig, vaultAta } from "@blindfold/protocol";
import { loadEnv, send } from "./common.ts";

const { connection, programId, usdcMint, admin } = loadEnv();
const mintAuthority = new PublicKey(process.env.MINT_AUTHORITY ?? admin.publicKey);
const config = configPda(programId);

const existing = await connection.getAccountInfo(config);
if (existing) {
  console.log("Config already exists, skipping initialize");
} else {
  const ix = buildInitializeIx({ programId, admin: admin.publicKey, usdcMint, mintAuthority, maxDeposit: centsToBaseUnits(MAX_DEPOSIT_CENTS) });
  console.log("initialize tx:", await send(connection, [ix], [admin]));
}
const info = await connection.getAccountInfo(config);
if (!info) throw new Error("Config not found after initialize");
const c = decodeConfig(info.data);
console.log(JSON.stringify({
  programId: programId.toBase58(),
  config: config.toBase58(),
  vaultToken: vaultAta(usdcMint, programId).toBase58(),
  admin: c.admin.toBase58(),
  mintAuthority: c.mintAuthority.toBase58(),
  usdcMint: c.usdcMint.toBase58(),
  maxDeposit: c.maxDeposit.toString(),
}, null, 2));
