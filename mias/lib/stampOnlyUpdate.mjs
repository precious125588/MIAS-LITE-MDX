// Decides whether a change from GitHub only refreshed the build stamp.
// The stamp commit carries no code, so the running bot does not need a restart for it.
export const BUILD_STAMP_FILE = "lib/precious-build-stamp.json";

export function isStampOnlyChange(files) {
  if (!Array.isArray(files)) return false;
  return files.every((file) => file === BUILD_STAMP_FILE);
}
