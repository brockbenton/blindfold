// Register a provider. usage: register-provider.ts <cashuPubkeyHex> <payoutTokenAccount>
// env: ADMIN_KEYPAIR, SOLANA_RPC_URL, VAULT_PROGRAM_ID
import { ECDH } from "node:crypto";
import { PublicKey } from "@solana/web3.js";
import { buildRegisterProviderIx, configPda, decodeConfig, isCompressedPubkeyHex, providerPda } from "@blindfold/protocol";
import { loadEnv, send } from "./common.ts";

const [cashuHex, payout] = process.argv.slice(2);
if (!cashuHex || !payout) throw new Error("usage: register-provider.ts <cashuPubkeyHex> <payoutTokenAccount>");
if (!isCompressedPubkeyHex(cashuHex)) throw new Error("cashu pubkey must be 33-byte compressed secp256k1 hex");
// The program only checks the 0x02/0x03 prefix; verify the point is on the curve here.
try {
  ECDH.convertKey(Buffer.from(cashuHex, "hex"), "secp256k1");
} catch {
  throw new Error("cashu pubkey is not a valid secp256k1 point");
}

const { connection, programId, admin } = loadEnv();
const cfgInfo = await connection.getAccountInfo(configPda(programId));
if (!cfgInfo) throw new Error("vault not initialized");
const providerId = decodeConfig(cfgInfo.data).providerCount;
const ix = buildRegisterProviderIx({ programId, admin: admin.publicKey, providerId, cashuPubkey: cashuHex.toLowerCase(), payoutToken: new PublicKey(payout) });
console.log("register_provider tx:", await send(connection, [ix], [admin]));
console.log(JSON.stringify({ providerId, providerRecord: providerPda(providerId, programId).toBase58() }, null, 2));
