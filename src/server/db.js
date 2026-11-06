// One Postgres pool per server instance, shared by Better Auth and the social
// endpoints. Serverless functions keep it small; Neon's pooler does the rest.

import pg from "pg";

const pools = new Map();

export function getPool(connectionString) {
  if (!pools.has(connectionString)) pools.set(connectionString, new pg.Pool({ connectionString, max: 3 }));
  return pools.get(connectionString);
}

/** Run one query; returns rows. */
export async function query(pool, text, values = []) {
  const result = await pool.query(text, values);
  return result.rows;
}

/** Run fn(client) inside a transaction. */
export async function transaction(pool, fn) {
  const client = await pool.connect();
  try {
    await client.query("begin");
    const out = await fn(client);
    await client.query("commit");
    return out;
  } catch (error) {
    await client.query("rollback");
    throw error;
  } finally {
    client.release();
  }
}
