import {
  applyMigrations,
  assertReadOnlyConnection,
  createNeonPool,
  safeDbErrorCode,
} from "../neonPersistence.js";

let pool;
try {
  pool = createNeonPool();
  await assertReadOnlyConnection(pool);
  const applied = await applyMigrations(pool);
  console.log(
    applied.length
      ? `Neon migrations: SUCCESS (${applied.join(", ")})`
      : "Neon migrations: SUCCESS (already current)",
  );
} catch (error) {
  console.error(`Neon migrations: FAILED (${safeDbErrorCode(error)})`);
  process.exitCode = 1;
} finally {
  try {
    await pool?.end();
  } catch {}
}
