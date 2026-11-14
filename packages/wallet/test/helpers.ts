import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { makeProviderKey } from "@blindfold/testkit";
import type { ProviderInfo } from "@blindfold/protocol";
import { AgentWallet, ownerFund, type WalletOptions } from "../src/index.js";
import { FakeDepositor } from "./fakes/fake-depositor.js";
import { FakeMint } from "./fakes/fake-mint.js";
import { FakeProvider, type ProviderMode } from "./fakes/fake-provider.js";

// Provider keys are fixed per process so issued tokens can be cached: blind issuance is slow in pure JS.
const KEYS = { pk: makeProviderKey(), other: makeProviderKey(), attacker: makeProviderKey() };
const fundCache = new Map<string, string>();

export interface World {
  dir: string;
  tokenFile: string;
  mint: FakeMint;
  provider: FakeProvider;
  other: { sk: string; pubkey: string };
  attacker: { sk: string; pubkey: string };
  depositor: FakeDepositor;
  /** Real owner flow once per (cents, prices) per process, then a cached copy of the file. `real: true` forces the flow. */
  fund(cents: number, prices?: Record<number, number>, real?: boolean): Promise<void>;
  open(o?: WalletOptions): Promise<AgentWallet>;
  file(): any;
  wallets: AgentWallet[];
  stop(): Promise<void>;
}

export async function makeWorld(o: { mode?: ProviderMode; priceCents?: number } = {}): Promise<World> {
  const dir = mkdtempSync(join(tmpdir(), "bf-wallet-"));
  const tokenFile = join(dir, "tokens.json");
  const { pk, other, attacker } = KEYS;
  const mint = new FakeMint();
  const providers: ProviderInfo[] = [
    { provider_id: 0, pubkey: pk.pubkey, name: "mock-api", url: null, price_cents: o.priceCents ?? 5, topics: ["sol"], active: true },
    { provider_id: 1, pubkey: other.pubkey, name: "other", url: null, price_cents: 5, topics: ["btc"], active: true },
  ];
  mint.setProviders(providers);
  const mintUrl = await mint.start();
  const provider = new FakeProvider({
    sk: pk.sk, mintUrl, spend: (s) => mint.spend(s), priceCents: o.priceCents, mode: o.mode,
    attackerKey: attacker.pubkey, keysetIds: [mint.keyset.id],
  });
  await provider.start();
  const depositor = new FakeDepositor(mint);
  const wallets: AgentWallet[] = [];
  const w: World = {
    dir, tokenFile, mint, provider, other, attacker, depositor, wallets,
    fund: async (cents, prices, real) => {
      const key = `${cents}:${JSON.stringify(prices ?? null)}:${mint.keyset.id}`;
      const cached = fundCache.get(key);
      if (cached && !real) {
        // The cached file embeds this world's mint URL.
        const f = JSON.parse(cached);
        f.mint = mintUrl;
        writeFileSync(tokenFile, JSON.stringify(f));
        return;
      }
      await ownerFund({ mintUrl, cents, prices, tokenFile, depositor, stateDir: join(dir, "state"), pollMs: 5 });
      if (!cached) fundCache.set(key, readFileSync(tokenFile, "utf8"));
    },
    open: async (opts = {}) => {
      const wal = await AgentWallet.open({ tokenFile, maxPerCallCents: 10, ...opts });
      wallets.push(wal);
      return wal;
    },
    file: () => JSON.parse(readFileSync(tokenFile, "utf8")),
    stop: async () => {
      wallets.forEach((x) => x.close());
      await provider.stop();
      await mint.stop();
    },
  };
  return w;
}
