// Solana Explorer links for the cluster behind an RPC URL.
function clusterQuery(rpc: string): string {
  if (/devnet/i.test(rpc)) return "?cluster=devnet";
  if (/testnet/i.test(rpc)) return "?cluster=testnet";
  return `?cluster=custom&customUrl=${encodeURIComponent(rpc)}`;
}

export const explorerTx = (signature: string, rpc: string) => `https://explorer.solana.com/tx/${signature}${clusterQuery(rpc)}`;
export const explorerAddress = (address: string, rpc: string) => `https://explorer.solana.com/address/${address}${clusterQuery(rpc)}`;
