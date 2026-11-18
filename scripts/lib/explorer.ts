// Solana Explorer links for the cluster behind an RPC URL.
function clusterQuery(rpc: string): string {
  if (/devnet/i.test(rpc)) return "?cluster=devnet";
  if (/testnet/i.test(rpc)) return "?cluster=testnet";
  const u = new URL(rpc);
  if (["localhost", "127.0.0.1", "[::1]"].includes(u.hostname)) {
    return `?cluster=custom&customUrl=${encodeURIComponent(u.origin)}`;
  }
  // These scripts default to devnet. A private RPC URL may embed credentials.
  return "?cluster=devnet";
}

export const explorerTx = (signature: string, rpc: string) => `https://explorer.solana.com/tx/${signature}${clusterQuery(rpc)}`;
export const explorerAddress = (address: string, rpc: string) => `https://explorer.solana.com/address/${address}${clusterQuery(rpc)}`;
