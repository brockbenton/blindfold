import { PaymentRefused } from "@blindfold/wallet";
import { NoProviderError, ReservesFailedError } from "./errors.js";
import type { CallResult, ReserveSummary, RunResult } from "./reporter.js";
import type { Tools } from "./tools.js";

export interface ScriptedOptions {
  topic: string;
  provider?: string;
  calls: number;
  reserveEvery: number;
}

/** 05-agent.md, Decision loop. The reserve gate fails closed: no paid call after a failed check. */
export async function runScripted(tools: Tools, o: ScriptedOptions): Promise<RunResult> {
  const start = (await tools.balance()).cents;
  if (start <= 0) throw new PaymentRefused("insufficient_balance", { balance: start });

  const providers = await tools.list_providers();
  if (providers.length === 0) throw new NoProviderError("the mint lists no active providers");
  let provider = providers[0];
  if (o.provider) {
    const named = providers.find((p) => p.name === o.provider);
    if (!named) throw new NoProviderError(`no active provider named ${o.provider}`);
    provider = named;
  } else {
    provider = providers.find((p) => p.topics.includes(o.topic)) ?? providers[0];
  }
  if (!provider.url) throw new NoProviderError(`provider ${provider.name ?? provider.provider_id} has no url`);
  const url = new URL(`/v1/data/${encodeURIComponent(o.topic)}`, provider.url).toString();

  const calls: CallResult[] = [];
  let reserves: ReserveSummary | null = null;
  for (let i = 0; i < o.calls; i++) {
    if (i % o.reserveEvery === 0) {
      reserves = await tools.check_reserves();
      if (!reserves.ok) throw new ReservesFailedError(reserves.reason ?? "reserve check failed", reserves.vaultCents, reserves.outstandingCents);
    }
    const r = await tools.call_paid_api({ url });
    calls.push({ status: r.status, paidCents: r.paidCents, data: r.data, ...(r.redemptionId ? { redemptionId: r.redemptionId } : {}) });
  }
  const end = (await tools.balance()).cents;
  const result: RunResult = {
    ok: true, provider, topic: o.topic, calls, balanceBefore: start, balanceAfter: end,
    paidCents: calls.reduce((s, c) => s + c.paidCents, 0), reserves,
  };
  await tools.report({
    summary: `paid ${result.paidCents}c to ${provider.name ?? provider.provider_id} for ${o.topic}, balance ${start}c -> ${end}c`,
    data: calls.map((c) => c.data),
  });
  return result;
}
