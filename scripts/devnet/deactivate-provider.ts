// Deactivate a provider. usage: deactivate-provider.ts <providerId>
// env: ADMIN_KEYPAIR, SOLANA_RPC_URL, VAULT_PROGRAM_ID
import { buildDeactivateProviderIx, providerPda } from "@blindfold/protocol";
import { loadEnv, send } from "./common.ts";

const id = Number.parseInt(process.argv[2] ?? "", 10);
if (!Number.isInteger(id) || id < 0) throw new Error("usage: deactivate-provider.ts <providerId>");
const { connection, programId, admin } = loadEnv();
if (!(await connection.getAccountInfo(providerPda(id, programId)))) throw new Error(`provider ${id} not registered`);
console.log("deactivate_provider tx:", await send(connection, [buildDeactivateProviderIx({ programId, admin: admin.publicKey, providerId: id })], [admin]));
