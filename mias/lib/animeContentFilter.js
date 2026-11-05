/**
 * Conservative metadata filter for anime-edit downloads.
 *
 * This intentionally rejects content that advertises AI generation,
 * synthetic/3D/cartoon rendering, or "animated" variants. It does not
 * reject the word "anime" because the requested source material is anime.
 *
 * This is a text/metadata gate, not a computer-vision model. A provider that
 * returns no useful metadata cannot be proven to be human-edited from a
 * downloaded byte stream alone, so callers should fail closed on blocked
 * metadata and keep the source restricted to the requested hashtag pool.
 */

const BLOCKED_PATTERNS = Object.freeze([
  /\bai\b/i,
  /\b(?:a[._\s-]*i|ai)[._\s-]*(?:generated|gen|art|artwork|animation|animated|video|edit)\b/i,
  /\b(?:generated|synthetic|deepfake|deep[._\s-]*fake|machine[._\s-]*generated)\b/i,
  /\b(?:animated|animation|cartoon|cartoons|toon|toons|cgi|3d|rendered|rendering)\b/i,
  /\b(?:midjourney|stable[._\s-]*diffusion|comfyui|leonardo[._\s-]*ai|dall[._\s-]*e|sora|runwayml?)\b/i,
  /\bwhat[._\s-]*if\b/i,
  /#(?:ai|aianime|aianimation|aivideo|aiedit|generated|cartoon|animation|animated|cgi|3d)\b/i,
]);

function flattenText(value, seen = new Set(), depth = 0) {
  if (value == null || depth > 3) return [];
  if (typeof value === "string" || typeof value === "number") return [String(value)];
  if (typeof value !== "object" || seen.has(value)) return [];
  seen.add(value);
  if (Array.isArray(value)) {
    return value.flatMap((item) => flattenText(item, seen, depth + 1));
  }
  return Object.entries(value)
    .filter(([key]) => !["buffer", "video", "download_url", "play", "hdplay"].includes(key))
    .flatMap(([, item]) => flattenText(item, seen, depth + 1));
}

export function candidateText(value) {
  return flattenText(value).join(" ").replace(/\s+/g, " ").trim();
}

export function blockedAnimeMarker(value) {
  const text = candidateText(value);
  return BLOCKED_PATTERNS.find((pattern) => pattern.test(text)) || null;
}

export function isAllowedAnimeCandidate(value, { required = [] } = {}) {
  if (blockedAnimeMarker(value)) return false;
  const text = candidateText(value).toLowerCase();
  return required.length === 0 || required.some((term) => text.includes(String(term).toLowerCase()));
}

export const AI_ANIMATED_BLOCK_PATTERNS = BLOCKED_PATTERNS;
