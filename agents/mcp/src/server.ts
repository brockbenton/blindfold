// MCP tools over a Session. There is no tool that changes a limit, approves a payment or skips the reserve gate:
// the reserve gate runs inside buy_data, and owner approval runs inside the wallet's payment hook.
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import type { Approver } from "@blindfold/wallet";
import { z } from "zod";
import { UNTRUSTED_NOTE, type Session } from "./session.js";

const json = (v: unknown, isError = false): CallToolResult => ({
  content: [{ type: "text", text: JSON.stringify(v, null, 2) }],
  ...(isError ? { isError: true } : {}),
});

export function createServer(o: { name?: string; version?: string } = {}): McpServer {
  return new McpServer(
    { name: o.name ?? "blindfold", version: o.version ?? "0.1.0" },
    {
      instructions: [
        "Blindfold pays for data with prepaid ecash tokens, so purchases leave no onchain record.",
        "Use list_providers, then buy_data with a provider URL.",
        "Spending limits are enforced in code: a refused purchase costs nothing and should not be retried.",
        UNTRUSTED_NOTE,
      ].join(" "),
    },
  );
}

/**
 * Owner approval through MCP elicitation: the client (e.g. Claude Desktop) shows the owner an approve/deny form.
 * A client without elicitation support gets a denial, so purchases above the threshold are refused.
 */
export function elicitationApprover(server: McpServer): Approver {
  return async (req, signal) => {
    if (!server.server.getClientCapabilities()?.elicitation) return false;
    const r = await server.server.elicitInput(
      {
        mode: "form",
        message: `Blindfold: approve paying ${req.cents} cents for ${req.url}? This is over your ${req.thresholdCents}-cent approval limit. No answer in ${Math.round(req.timeoutMs / 1000)} s counts as a denial.`,
        requestedSchema: {
          type: "object",
          properties: { approve: { type: "boolean", title: "Approve this purchase (untick to deny)", default: true } },
          required: ["approve"],
        },
      },
      { signal, timeout: req.timeoutMs },
    );
    return r.action === "accept" && r.content?.approve === true;
  };
}

export function registerTools(server: McpServer, session: Session): void {
  server.registerTool(
    "list_providers",
    {
      title: "List data providers",
      description: "List the registered data providers you can buy from: name, base URL, base price in cents and topics. Routes can cost more than the base price; call quote(url) for a route's exact price.",
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    async () => {
      try {
        return json(await session.providers());
      } catch (e) {
        return json({ error: `cannot list providers: ${(e as Error).message}` }, true);
      }
    },
  );

  server.registerTool(
    "get_balance",
    {
      title: "Token balance",
      description: "Your remaining prepaid token balance, and how much of this session's budget is spent, in cents.",
      annotations: { readOnlyHint: true },
    },
    async () => json(session.balance()),
  );

  server.registerTool(
    "check_reserves",
    {
      title: "Check vault reserves",
      description: "Compare the Blindfold vault's USDC balance on Solana with its outstanding liabilities, read from the vault's onchain issuance log when it exists (verified) or else from the mint's report. buy_data runs this check itself; this tool only reports it.",
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    async () => {
      const r = await session.reserves();
      return json({
        ok: r.ok, vault_cents: r.vaultCents, outstanding_cents: r.outstandingCents, verified: r.verified === true,
        ...(r.note ? { note: r.note } : {}), ...(r.reason ? { reason: r.reason } : {}),
      });
    },
  );

  server.registerTool(
    "quote",
    {
      title: "Price of a URL",
      description: "The exact price in cents of one buy_data call to this URL, read from the provider's unpaid HTTP 402 challenge. Spends nothing. Use it before buying anything that may cost more than the provider's base price.",
      inputSchema: { url: z.string().describe("Full URL on a provider from list_providers") },
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    async ({ url }) => {
      const r = await session.quote(url);
      return json(r, "error" in r);
    },
  );

  server.registerTool(
    "buy_data",
    {
      title: "Buy data privately",
      description: [
        "Buy one data response with a paid HTTP GET, paid with a Blindfold token (no onchain transaction).",
        "Routes on a provider's base URL: whale flow <url>/v1/data/<token>, order-book depth <url>/v1/data/<token>/depth,",
        "premium trade signals <url>/v1/data/<token>/signals. Prices differ by route: call quote(url) first when unsure.",
        "Returns {refused: reason} when a limit, the wallet or the owner says no; nothing is spent then.",
        UNTRUSTED_NOTE,
      ].join(" "),
      inputSchema: { url: z.string().describe("Full URL to GET, on a provider from list_providers") },
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
    },
    async ({ url }) => {
      const r = await session.buy(url);
      if ("ok" in r) return json({ ...r, note: UNTRUSTED_NOTE });
      return json(r, "error" in r);
    },
  );
}
