import { createApp } from "./app.js";
import { openDb } from "./db.js";

const db = openDb(process.env.BUDGET_DB ?? "data/budget.db");
const port = Number(process.env.PORT ?? 5174);
// Local-only app: bind loopback so nothing on the network can reach the financial data.
createApp(db).listen(port, "127.0.0.1", () => console.log(`API listening on http://127.0.0.1:${port}`));
