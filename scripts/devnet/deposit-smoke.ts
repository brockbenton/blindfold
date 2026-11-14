// Deposit smoke test. usage: deposit-smoke.ts [cents=100]
// env: DEPOSITOR_KEYPAIR (default ADMIN_KEYPAIR), SOLANA_RPC_URL, VAULT_PROGRAM_ID, USDC_MINT
import { randomBytes } from "node:crypto";
import { getAssociatedTokenAddressSync } from "@solana/spl-token";
import { buildDepositIx, centsToBaseUnits, configPda, decodeConfig, decodeDepositRecord, depositPda } from "@blindfold/protocol";
import { loadEnv, loadKeypair, send } from "./common.ts";

const { connection, programId, usdcMint, admin } = loadEnv();
const depositor = process.env.DEPOSITOR_KEYPAIR ? loadKeypair(process.env.DEPOSITOR_KEYPAIR) : admin;
const cents = Number(process.argv[2] ?? 100);
const depositorToken = getAssociatedTokenAddressSync(usdcMint, depositor.publicKey);

const cfgInfo = await connection.getAccountInfo(configPda(programId));
if (!cfgInfo) throw new Error("vault not initialized");
const depositIndex = decodeConfig(cfgInfo.data).depositCount;
const depositRef = randomBytes(32);
const ix = buildDepositIx({ programId, depositor: depositor.publicKey, depositorToken, usdcMint, amount: centsToBaseUnits(cents), depositRef, depositIndex });
console.log("deposit tx:", await send(connection, [ix], [depositor]));
const rec = await connection.getAccountInfo(depositPda(depositIndex, programId));
if (!rec) throw new Error("DepositRecord not found");
const d = decodeDepositRecord(rec.data);
console.log(JSON.stringify({ index: d.index.toString(), amount: d.amount.toString(), depositor: d.depositor.toBase58(), depositRef: Buffer.from(d.depositRef).toString("hex") }, null, 2));
