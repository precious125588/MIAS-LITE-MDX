'use strict';
// Retry rules for the .fetch command.
// A 4xx response means the server refused the request, so retrying will not help.
// The exceptions are 408 (timeout) and 429 (rate limit), which can succeed later.
// Network errors (no HTTP response) and 5xx responses are retried.

function getHttpStatus(err) {
  const status = err?.response?.status;
  return typeof status === 'number' ? status : null;
}

function shouldRetryFetch(err) {
  const status = getHttpStatus(err);
  if (status === null) return true;
  if (status === 408 || status === 429) return true;
  return status >= 500;
}

function describeFetchFailure(err, url) {
  const status = getHttpStatus(err);
  let host = String(url || '');
  try { host = new URL(url).host; } catch { /* keep raw value */ }
  if (status !== null) {
    const text = err.response.statusText ? ' ' + err.response.statusText : '';
    return `HTTP ${status}${text} from ${host}. The file may be removed or private, or the link may be wrong.`;
  }
  return err?.code || err?.message || 'connection failed';
}

module.exports = { shouldRetryFetch, describeFetchFailure, getHttpStatus };
