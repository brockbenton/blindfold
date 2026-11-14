import { Hono } from "hono";
import { ZodError } from "zod";
import { MintError } from "./errors.js";
import type { Ctx } from "./ctx.js";
import { adminRoutes } from "./routes/admin.js";
import { infoRoutes } from "./routes/info.js";
import { mintRoutes } from "./routes/mint.js";
import { quoteRoutes } from "./routes/quote.js";
import { redeemRoutes } from "./routes/redeem.js";

export function createApp(ctx: Ctx) {
  const app = new Hono();
  app.route("/", infoRoutes(ctx));
  app.route("/", quoteRoutes(ctx));
  app.route("/", mintRoutes(ctx));
  app.route("/", redeemRoutes(ctx));
  app.route("/", adminRoutes(ctx));
  app.onError((e, c) => {
    if (e instanceof MintError) return c.json({ detail: e.detail, code: e.code }, e.status as 400);
    if (e instanceof ZodError) return c.json({ detail: "malformed request", code: 10000 }, 400);
    console.error(e);
    return c.json({ detail: "internal error", code: 0 }, 500);
  });
  return app;
}
