/**
 * APKMirror scraper & helper for Levanter plugins in MIAS
 */
import axios from "axios";

export async function apkMirror(query, message = null) {
  const q = String(query || "").trim();
  if (!q) return { status: 400, result: "Please provide an app name or query." };

  // Try David Cyril Tech APK endpoint
  try {
    const { data } = await axios.get(
      `https://apis.davidcyriltech.my.id/download/apk?text=${encodeURIComponent(q)}`,
      { timeout: 10000 }
    );
    const link = data?.apk?.downloadLink || data?.downloadLink || data?.result?.downloadLink;
    const name = data?.apk?.name || data?.name || q;
    const size = data?.apk?.size ? `Size: ${data.apk.size}` : "";

    if (link) {
      return {
        status: 200,
        result: link,
        name,
        size
      };
    }
  } catch {}

  // Fallback search result
  return {
    status: 200,
    result: `https://www.apkmirror.com/?post_type=app_release&searchtype=apk&s=${encodeURIComponent(q)}`,
    name: q
  };
}
