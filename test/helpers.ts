import type { AddressInfo } from "node:net";
import { createApp } from "../server/app.js";
import { openDb } from "../server/db.js";

export async function startApp(today = "2026-10-25") {
  const db = openDb(":memory:");
  const server = createApp(db, () => today).listen(0, "127.0.0.1");
  await new Promise((r) => server.once("listening", r));
  const port = (server.address() as AddressInfo).port;
  const base = `http://127.0.0.1:${port}`;
  async function call(method: string, path: string, body?: unknown) {
    const get = method === "GET";
    const res = await fetch(base + path, {
      method, headers: get ? {} : { "content-type": "application/json" },
      body: get ? undefined : JSON.stringify(body ?? {}),
    });
    const text = await res.text();
    return { status: res.status, body: text ? JSON.parse(text) : null };
  }
  return { db, port, base, call, close: () => server.close() };
}
