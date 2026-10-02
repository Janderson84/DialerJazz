/**
 * ensure-schema.ts — schema self-healing guard.
 *
 * InsForge's backend reconciles its schema periodically and has been observed
 * dropping user functions it doesn't know about (increment_campaign_calls was
 * dropped ~30 min after creation on 2026-10-03). This script re-applies
 * anything fragile at server startup, so a schema regression self-heals on
 * the next restart instead of silently breaking campaign progress counters.
 */
import { readFileSync } from 'fs';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';
import { Client } from 'pg';
import dotenv from 'dotenv';

dotenv.config({ path: join(dirname(dirname(dirname(fileURLToPath(import.meta.url)))), '.env') });

const PG = {
  host: process.env.PGHOST || 'localhost',
  port: Number(process.env.PGPORT || 5432),
  user: process.env.PGUSER || 'postgres',
  password: process.env.PGPASSWORD || undefined,
  database: process.env.PGDATABASE || 'insforge',
};

// Order matters. Each statement re-applied idempotently.
const FRAGILE = [
  'increment-campaign-calls.sql',
];

export async function ensureSchema(): Promise<void> {
  const client = new Client(PG);
  try {
    await client.connect();
    for (const f of FRAGILE) {
      const sqlPath = join(dirname(dirname(fileURLToPath(import.meta.url))), '..', 'sql', f);
      try {
        const sql = readFileSync(sqlPath, 'utf8');
        await client.query(sql);
        console.log(`[ensure-schema] applied ${f}`);
      } catch (e: any) {
        console.error(`[ensure-schema] FAILED ${f}:`, e?.message || e);
      }
    }
    // PostgREST caches the schema at startup; without this reload it can't see
    // re-applied functions and every RPC fails with PGRST202 until restart.
    await client.query("NOTIFY pgrst, 'reload schema';");
  } catch (e: any) {
    // Never block server boot over schema healing.
    console.error('[ensure-schema] could not reach postgres:', e?.message || e);
  } finally {
    try { await client.end(); } catch { /* noop */ }
  }
}
