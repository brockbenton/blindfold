import { createPool, migrate } from "./db.js";

const db = createPool(process.env.DATABASE_URL ?? "");
console.log("applied:", await migrate(db));
await db.end();
