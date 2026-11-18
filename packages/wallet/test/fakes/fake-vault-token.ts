import { PublicKey } from "@solana/web3.js";

export function fakeVaultToken(mint: PublicKey, config: PublicKey, balance: bigint) {
  const data = Buffer.alloc(165);
  mint.toBuffer().copy(data, 0);
  config.toBuffer().copy(data, 32);
  data.writeBigUInt64LE(balance, 64);
  data[108] = 1; // initialized
  return { owner: new PublicKey("TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA"), data };
}
