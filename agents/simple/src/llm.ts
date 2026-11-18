// LLM decision loop (05-agent.md, LLM mode). The model chooses which data to buy and decides; code enforces the
// limits around every paid call: the reserve gate (fail closed), a session budget and a step limit. The wallet adds
// owner approval for purchases above its threshold; the model cannot skip it because it is not a tool. Payment refusals
// go back to the model as tool results, so a refused hijack attempt costs nothing and the run continues.
//
// Any OpenAI-compatible chat completions endpoint works (Gemini's, Groq's, OpenAI's...), called with plain fetch.
import { PaymentRefused } from "@blindfold/wallet";
import type { ProviderInfo } from "@blindfold/protocol";
import { HttpError, ReservesFailedError } from "./errors.js";
import type { ReserveSummary } from "./reporter.js";
import type { Tools } from "./tools.js";

export interface ToolCall { id: string; type: "function"; function: { name: string; arguments: string } }
export interface ChatMessage {
  role: "system" | "user" | "assistant" | "tool";
  content: string | null;
  tool_calls?: ToolCall[];
  tool_call_id?: string;
  [extra: string]: unknown;
}
export interface ToolSpec { type: "function"; function: { name: string; description: string; parameters: Record<string, unknown> } }
/** One model turn: the conversation so far in, the assistant's message out. */
export type Chat = (messages: ChatMessage[], tools: ToolSpec[]) => Promise<ChatMessage>;

export const GEMINI_OPENAI_BASE_URL = "https://generativelanguage.googleapis.com/v1beta/openai";
/** Comma-separated fallbacks: the next model is tried when one is overloaded (503) or unavailable (404). */
export const DEFAULT_LLM_MODEL = "gemini-3.5-flash-lite,gemini-flash-latest";

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/**
 * OpenAI-compatible chat completions. `model` may list fallbacks separated by commas; a model that is overloaded or
 * unavailable is skipped for the rest of the session. Rate limits and other server errors are retried.
 */
export function openAiChat(o: { baseUrl: string; apiKey: string; model: string; fetch?: typeof fetch; timeoutMs?: number }): Chat {
  const f = o.fetch ?? fetch;
  const models = o.model.split(",").map((m) => m.trim()).filter(Boolean);
  return async (messages, tools) => {
    for (let attempt = 1; ; attempt++) {
      const res = await f(`${o.baseUrl.replace(/\/+$/, "")}/chat/completions`, {
        method: "POST",
        headers: { "content-type": "application/json", authorization: `Bearer ${o.apiKey}` },
        body: JSON.stringify({ model: models[0], messages, tools, tool_choice: "auto", temperature: 0 }),
        signal: AbortSignal.timeout(o.timeoutMs ?? 60_000),
      });
      if (res.ok) {
        const j = (await res.json()) as { choices?: { message?: ChatMessage }[] };
        const m = j.choices?.[0]?.message;
        if (!m) throw new Error("model returned no message");
        return m;
      }
      const body = await res.text().catch(() => "");
      if ((res.status === 503 || res.status === 404) && models.length > 1) {
        models.shift();
        continue;
      }
      if ((res.status === 429 || res.status >= 500) && attempt < 4) {
        await sleep(2000 * attempt);
        continue;
      }
      throw new Error(`model API HTTP ${res.status}: ${body.slice(0, 200)}`);
    }
  };
}

export const SYSTEM_PROMPT = [
  "You are a crypto trading research agent. Your owner gives you a goal and a budget of prepaid tokens.",
  "Use list_providers to find data providers, then buy_data to buy the data you need. Each purchase costs a few cents.",
  "Buy only what you need: usually the whale flow first, then order-book depth if it helps.",
  "Premium trade signals cost more; a purchase above your owner's approval limit waits for the owner, who may refuse it.",
  "When you have enough information, call final_answer with BUY, SELL or HOLD and a short rationale (one or two sentences).",
].join(" ");

const TOOLS: ToolSpec[] = [
  { type: "function", function: { name: "list_providers", description: "List the data providers you can buy from: name, base url, price in cents, topics.", parameters: { type: "object", properties: {} } } },
  { type: "function", function: { name: "get_balance", description: "Your remaining token balance in cents.", parameters: { type: "object", properties: {} } } },
  {
    type: "function",
    function: {
      name: "buy_data",
      description: "Buy one data response with a paid HTTP GET. Whale flow: <provider url>/v1/data/<token>. Order-book depth: <provider url>/v1/data/<token>/depth. Premium trade signals: <provider url>/v1/data/<token>/signals.",
      parameters: { type: "object", properties: { url: { type: "string", description: "Full URL to GET" } }, required: ["url"] },
    },
  },
  {
    type: "function",
    function: {
      name: "final_answer",
      description: "Finish with your trading decision.",
      parameters: {
        type: "object",
        properties: { decision: { type: "string", enum: ["BUY", "SELL", "HOLD"] }, rationale: { type: "string" } },
        required: ["decision", "rationale"],
      },
    },
  },
];

export interface LlmStep {
  tool: string;
  args: Record<string, unknown>;
  /** "ok", "refused" (the wallet or a limit said no; nothing paid) or "error". */
  outcome: "ok" | "refused" | "error";
  paidCents: number;
  /** Why it was refused or failed, e.g. provider_not_allowed, budget_exhausted. */
  reason?: string;
  data?: unknown;
}

export interface LlmRunResult {
  ok: true;
  mode: "llm";
  goal: string;
  decision: "BUY" | "SELL" | "HOLD";
  rationale: string;
  steps: LlmStep[];
  balanceBefore: number;
  balanceAfter: number;
  paidCents: number;
  reserves: ReserveSummary | null;
}

export interface LlmOptions {
  goal: string;
  chat: Chat;
  /** Session budget in cents; code refuses further purchases once spent. */
  budgetCents: number;
  /** Model turns before the agent stops with HOLD. */
  maxSteps?: number;
  /** Reserve check before the first paid call and every N paid calls after (00 section 7.6). */
  reserveEvery: number;
  onStep?: (s: LlmStep) => void;
}

const parseArgs = (s: string): Record<string, unknown> => {
  try {
    const v = JSON.parse(s || "{}");
    return v && typeof v === "object" ? v : {};
  } catch {
    return {};
  }
};

export async function runLlm(tools: Tools, o: LlmOptions): Promise<LlmRunResult> {
  const start = (await tools.balance()).cents;
  if (start <= 0) throw new PaymentRefused("insufficient_balance", { balance: start });
  const messages: ChatMessage[] = [
    { role: "system", content: SYSTEM_PROMPT },
    { role: "user", content: `Goal: ${o.goal}\nBudget: ${o.budgetCents} cents.` },
  ];
  const steps: LlmStep[] = [];
  let reserves: ReserveSummary | null = null;
  let paidCalls = 0;
  const record = (s: LlmStep) => { steps.push(s); o.onStep?.(s); return s; };
  // Registered providers serving this URL's origin; the wallet refuses any other signer. Read once per run.
  let providers: Promise<ProviderInfo[]> | null = null;
  const providerKeysFor = async (url: string): Promise<string[]> => {
    let origin: string;
    try {
      origin = new URL(url).origin;
    } catch {
      return [];
    }
    const list = await (providers ??= tools.list_providers());
    return list.filter((p) => { try { return !!p.url && new URL(p.url).origin === origin; } catch { return false; } }).map((p) => p.pubkey.toLowerCase());
  };
  const finish = async (decision: LlmRunResult["decision"], rationale: string): Promise<LlmRunResult> => {
    const end = (await tools.balance()).cents;
    return { ok: true, mode: "llm", goal: o.goal, decision, rationale, steps, balanceBefore: start, balanceAfter: end, paidCents: start - end, reserves };
  };

  for (let turn = 0; turn < (o.maxSteps ?? 10); turn++) {
    const reply = await o.chat(messages, TOOLS);
    // Echo the assistant message back unchanged: some providers attach signatures to tool calls that must round-trip.
    messages.push({ ...reply, role: "assistant" });
    const calls = reply.tool_calls ?? [];
    if (calls.length === 0) {
      const text = String(reply.content ?? "");
      const d = /\b(BUY|SELL|HOLD)\b/.exec(text)?.[1] as LlmRunResult["decision"] | undefined;
      return finish(d ?? "HOLD", text.trim() || "no decision given");
    }
    for (const call of calls) {
      const args = parseArgs(call.function.arguments);
      const name = call.function.name;
      let result: unknown;
      if (name === "final_answer") {
        const d = String(args.decision ?? "").toUpperCase();
        record({ tool: name, args, outcome: "ok", paidCents: 0 });
        return finish((["BUY", "SELL", "HOLD"].includes(d) ? d : "HOLD") as LlmRunResult["decision"], String(args.rationale ?? ""));
      } else if (name === "list_providers") {
        const ps = await tools.list_providers();
        result = ps.map((p) => ({ name: p.name, url: p.url, price_cents: p.price_cents, topics: p.topics }));
        record({ tool: name, args, outcome: "ok", paidCents: 0, data: result });
      } else if (name === "get_balance") {
        result = await tools.balance();
        record({ tool: name, args, outcome: "ok", paidCents: 0, data: result });
      } else if (name === "buy_data") {
        result = await buy(String(args.url ?? ""));
      } else {
        result = { error: `unknown tool ${name}` };
        record({ tool: name, args, outcome: "error", paidCents: 0, reason: "unknown_tool" });
      }
      messages.push({ role: "tool", tool_call_id: call.id, content: JSON.stringify(result) });

      async function buy(url: string): Promise<unknown> {
        const spent = start - (await tools.balance()).cents;
        if (spent >= o.budgetCents) {
          record({ tool: "buy_data", args, outcome: "refused", paidCents: 0, reason: "budget_exhausted" });
          return { refused: "budget_exhausted", detail: `spent ${spent} of ${o.budgetCents} cents` };
        }
        // The reserve gate is code, not a tool the model may skip: a failed check ends the run before paying.
        if (paidCalls % o.reserveEvery === 0) {
          reserves = await tools.check_reserves();
          if (!reserves.ok) throw new ReservesFailedError(reserves);
        }
        // The budget check above only knows past spend. The wallet checks the actual validated price against what is
        // left, inside its payment lock, so one purchase cannot cross the budget.
        const limits = { maxCents: o.budgetCents - spent, providerPubkeys: await providerKeysFor(url) };
        try {
          const r = await tools.call_paid_api({ url, limits });
          paidCalls++;
          record({ tool: "buy_data", args, outcome: "ok", paidCents: r.paidCents, data: r.data });
          return r.data;
        } catch (e) {
          if (e instanceof PaymentRefused) {
            record({ tool: "buy_data", args, outcome: "refused", paidCents: 0, reason: e.reason });
            const owner = e.reason === "approval_denied" || e.reason === "approval_timeout";
            return { refused: e.reason, detail: owner ? "your owner did not approve this purchase; nothing was spent. Do not retry it."
              : e.reason === "budget_exhausted" ? `this purchase costs more than the ${o.budgetCents - spent} cents left in your budget; nothing was spent`
              : "the wallet refused to pay; nothing was spent" };
          }
          if (e instanceof HttpError) {
            record({ tool: "buy_data", args, outcome: "error", paidCents: 0, reason: `http_${e.status}` });
            return { error: `HTTP ${e.status}` };
          }
          const msg = (e as Error).message;
          record({ tool: "buy_data", args, outcome: "error", paidCents: 0, reason: msg.slice(0, 120) });
          return { error: msg.slice(0, 200) };
        }
      }
    }
  }
  return finish("HOLD", "step limit reached before a decision");
}
