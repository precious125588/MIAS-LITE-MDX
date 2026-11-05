import fs from "node:fs/promises";
import path from "node:path";
import {
  assertReadOnlyConnection,
  createNeonPool,
  derivePersistenceScope,
  readBotState,
  safeDbErrorCode,
} from "../neonPersistence.js";
import { DB_FILES } from "../database.js";

let pool;
try {
  pool = createNeonPool();
  await assertReadOnlyConnection(pool);
  const scope = derivePersistenceScope();
  const state = await readBotState(pool, scope);
  if (!state) throw Object.assign(new Error("No state row"), { code: "STATE_NOT_FOUND" });

  const outputDir = process.env.MIAS_EXPORT_DIR
    ? path.resolve(process.env.MIAS_EXPORT_DIR)
    : path.join(path.dirname(DB_FILES.economy), `neon-export-${Date.now()}`);
  await fs.mkdir(outputDir, { recursive: false });

  for (const [store, filePath] of Object.entries(DB_FILES)) {
    if (!Object.prototype.hasOwnProperty.call(state.payload, store)) continue;
    await fs.writeFile(
      path.join(outputDir, path.basename(filePath)),
      `${JSON.stringify(state.payload[store], null, 2)}\n`,
      { encoding: "utf8", flag: "wx", mode: 0o600 },
    );
  }

  console.log("Neon state export: SUCCESS (app-state JSON only; no auth files)");
} catch (error) {
  console.error(`Neon state export: FAILED (${safeDbErrorCode(error)})`);
  process.exitCode = 1;
} finally {
  try {
    await pool?.end();
  } catch {}
}
