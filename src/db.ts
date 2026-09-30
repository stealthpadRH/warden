import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import postgres from "postgres";
import { cfg } from "./config.ts";

export const sql = postgres(cfg.databaseUrl, { max: 8, idle_timeout: 30, onnotice: () => {} });

export async function migrate() {
  const here = path.dirname(fileURLToPath(import.meta.url));
  await sql.unsafe(fs.readFileSync(path.join(here, "schema.sql"), "utf8"));
}

export async function getMeta(key: string): Promise<string | null> {
  const r = await sql`select value from meta where key = ${key}`;
  return r.length ? (r[0].value as string) : null;
}

export async function setMeta(key: string, value: string) {
  await sql`insert into meta (key, value) values (${key}, ${value}) on conflict (key) do update set value = excluded.value`;
}

export const big = (v: unknown) => BigInt(String(v ?? "0"));
