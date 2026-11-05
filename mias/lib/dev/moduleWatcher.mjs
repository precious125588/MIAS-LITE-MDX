import chokidar from "chokidar";
import { fileURLToPath, pathToFileURL } from "node:url";

export async function startModuleWatcher(targets, options = {}) {
  const watchTargets = (Array.isArray(targets) ? targets : [targets]).map((target) =>
    target instanceof URL ? fileURLToPath(target) : target
  );
  const watcher = chokidar.watch(watchTargets, {
    ignoreInitial: true,
    awaitWriteFinish: { stabilityThreshold: 250, pollInterval: 50 },
    ignored: /(^|[/\\])node_modules([/\\]|$)/,
  });

  const reloadable = new Set([".js", ".mjs", ".cjs"]);
  watcher.on("all", async (event, filePath) => {
    if (!reloadable.has(filePath.slice(filePath.lastIndexOf("."))) || event === "unlink") return;
    try {
      const url = `${pathToFileURL(filePath).href}?reload=${Date.now()}`;
      await import(url);
      options.onReload?.(filePath);
      console.log(`[MIAS watcher] checked ${filePath}`);
    } catch (error) {
      console.error(`[MIAS watcher] reload failed for ${filePath}:`, error.message);
    }
  });

  console.log(`[MIAS watcher] watching ${watchTargets.length} development paths`);
  return watcher;
}

// Standalone CLI remains available for local development.
if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const target = process.argv[2];
  if (!target) {
    console.error("Usage: node mias/lib/dev/moduleWatcher.mjs <module-or-directory>");
    process.exitCode = 1;
  } else {
    const watcher = await startModuleWatcher(target);
    process.once("SIGINT", () => watcher.close().finally(() => process.exit(0)));
    process.once("SIGTERM", () => watcher.close().finally(() => process.exit(0)));
  }
}