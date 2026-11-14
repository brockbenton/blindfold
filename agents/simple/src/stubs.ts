import type { ProviderInfo } from "@blindfold/protocol";
import { PaymentFailed, PaymentRefused } from "@blindfold/wallet";
import type { Tools, WalletLike } from "./tools.js";

type Env = Record<string, string | undefined>;

/** Same shape as AgentWallet (00 section 8.1). payFetch deducts the price and returns canned data. */
export function fakeWallet(startCents = 100, priceCents = 5, maxPerCallCents = 10, env: Env = {}): WalletLike {
  let balance = startCents;
  return {
    balance: () => balance,
    async payFetch(url: string | URL) {
      if (env.FAKE_FAIL_STATUS) throw new PaymentFailed(Number(env.FAKE_FAIL_STATUS), "", { returned: 0, dropped: 0 });
      if (priceCents > maxPerCallCents) throw new PaymentRefused("over_cap", { priceCents });
      if (balance < priceCents) throw new PaymentRefused("insufficient_balance", { balance });
      balance -= priceCents;
      const topic = new URL(url.toString()).pathname.split("/").pop() ?? "";
      return new Response(
        JSON.stringify({ topic, price: 172.4, change_24h_pct: -1.2, volume_24h: 123456789, whale_netflow: 42000, as_of: 1763166400, fake: true }),
        { status: 200, headers: { "content-type": "application/json" } },
      );
    },
  };
}

export const fakeProviders: ProviderInfo[] = [
  { provider_id: 0, pubkey: "02" + "11".repeat(32), name: "mock-api", url: "http://localhost:4000", price_cents: 5, topics: ["sol", "btc", "eth"], active: true },
];

export function fakeReserves(env: Env = {}): Tools["check_reserves"] {
  return async () =>
    env.FAKE_RESERVES_FAIL === "1"
      ? { ok: false, vaultCents: 100, outstandingCents: 180, reason: "vault_below_outstanding" }
      : { ok: true, vaultCents: 250, outstandingCents: 180 };
}
