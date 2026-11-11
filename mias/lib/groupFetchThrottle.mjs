// Baileys' groupFetchAllParticipating() downloads every group's full participant
// list. On a big account that is a lot of data over the linked-device connection.
// The bot called it on every connect from several places, and some timers repeated
// it every few minutes. This keeps one result per socket for a while:
//   • concurrent callers share one request
//   • a result is reused until the TTL passes
//   • empty or failed results are never cached, so the next call retries

export const GROUP_FETCH_TTL_MS = 10 * 60 * 1000;
const MARK = "__groupFetchThrottled";

export function throttleGroupFetch(sock, { ttlMs = GROUP_FETCH_TTL_MS, now = () => Date.now() } = {}) {
  if (!sock || typeof sock.groupFetchAllParticipating !== "function") return false;
  if (sock[MARK]) return false;

  const original = sock.groupFetchAllParticipating.bind(sock);
  let cached = null;
  let cachedAt = 0;
  let inflight = null;

  sock.groupFetchAllParticipating = function throttledGroupFetchAllParticipating(...args) {
    if (cached && now() - cachedAt < ttlMs) return Promise.resolve(cached);
    if (inflight) return inflight;
    inflight = Promise.resolve()
      .then(() => original(...args))
      .then((result) => {
        if (result && typeof result === "object" && Object.keys(result).length > 0) {
          cached = result;
          cachedAt = now();
        }
        return result;
      })
      .finally(() => {
        inflight = null;
      });
    return inflight;
  };

  sock[MARK] = true;
  return true;
}
