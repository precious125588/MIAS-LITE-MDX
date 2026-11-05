import {
  assertReadOnlyConnection,
  createNeonPool,
  safeDbErrorCode,
} from "../neonPersistence.js";

let pool;
try {
  pool = createNeonPool();
  const result = await assertReadOnlyConnection(pool);
  console.log(`Neon connection: SUCCESS (${result.databaseName})`);
} catch (error) {
  console.error(`Neon connection: FAILED (${safeDbErrorCode(error)})`);
  process.exitCode = 1;
} finally {
  try {
    await pool?.end();
  } catch {}
}
