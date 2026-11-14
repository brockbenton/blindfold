import type { AgentWallet } from "./agent-wallet.js";

/** Thin LLM tool wrapper around payFetch. */
export function payFetchTool(wallet: AgentWallet) {
  return {
    name: "pay_fetch",
    description: "HTTP GET a URL, paying automatically with Blindfold tokens if the server answers 402.",
    async execute(args: { url: string }): Promise<{ status: number; body: string }> {
      const res = await wallet.payFetch(args.url);
      return { status: res.status, body: await res.text() };
    },
  };
}
