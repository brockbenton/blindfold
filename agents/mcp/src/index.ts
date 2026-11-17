#!/usr/bin/env node
// Blindfold MCP server over stdio. stdout carries the protocol, so logs go to stderr.
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { loadConfig } from "./config.js";
import { start } from "./start.js";

async function main() {
  const cfg = loadConfig(process.env);
  const s = await start(cfg);
  const stop = async () => { await s.close(); process.exit(0); };
  process.on("SIGINT", stop);
  process.on("SIGTERM", stop);
  process.stdin.on("close", stop);
  await s.server.connect(new StdioServerTransport());
  process.stderr.write(
    `blindfold-mcp: ${s.wallet.balance()} cents of tokens, mint ${s.mintUrl}, budget ${cfg.budgetCents}, ` +
    `cap ${cfg.maxPerCallCents}, approval over ${cfg.approvalOverCents}\n`,
  );
}

main().catch((e) => {
  process.stderr.write(`blindfold-mcp: ${(e as Error).message}\n`);
  process.exit(1);
});
