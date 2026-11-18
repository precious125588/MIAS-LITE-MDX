import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const REPO_ROOT = path.resolve(__dirname, "..", "..");
const AUTH_FILE = path.join(REPO_ROOT, "nexstore", "asitha_auth.json");

const ASITHA_API_BASE = "https://back.asitha.top/api";
const ASITHA_SIG_SECRET = "AsithaApiSignatureKey2026!@#";
const HCAPTCHA_SITEKEY = "3acc5934-433c-46a8-82ba-51c03050c64a";
const HCAPTCHA_PAGE_URL = "https://asitha.top/channel-manager";
const DEFAULT_REACTIONS = "🦄,🩷,🌼,🤍,💗";

/**
 * Valid reaction counts supported by Asitha Channel Manager.
 */
export const VALID_COUNTS = ["1", "10", "20", "30", "40", "50", "all"];

/**
 * Parse user quantity input. \"mass\", \"max\", \"all\" map to \"all\" (maximum).
 */
export function parseReactionCount(raw) {
  if (!raw) return "all";
  const str = String(raw).trim().toLowerCase();
  if (/^(mass|max|maximum|all|bots|allbots)$/i.test(str)) {
    return "all";
  }
  const num = parseInt(str, 10);
  if (isNaN(num)) return "all";
  if (num <= 1) return "1";
  if (num <= 10) return "10";
  if (num <= 20) return "20";
  if (num <= 30) return "30";
  if (num <= 40) return "40";
  if (num <= 50) return "50";
  return "all";
}

/**
 * Read persistent auth token or API key from disk or environment.
 */
export function getStoredAuth() {
  let diskData = {};
  try {
    if (fs.existsSync(AUTH_FILE)) {
      diskData = JSON.parse(fs.readFileSync(AUTH_FILE, "utf8")) || {};
    }
  } catch (_) {}

  const apiKey = diskData.apiKey || process.env.ASITHA_API_KEY || process.env.ASITHA_TEMP_TOKEN || "";
  const jwtToken = diskData.jwtToken || process.env.ASITHA_JWT_TOKEN || "";
  return { apiKey, jwtToken, diskData };
}

/**
 * Save auth token or API key to disk for persistent bot restarts.
 */
export function saveStoredAuth(data = {}) {
  try {
    const dir = path.dirname(AUTH_FILE);
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    const current = getStoredAuth().diskData;
    const merged = { ...current, ...data, updatedAt: Date.now() };
    fs.writeFileSync(AUTH_FILE, JSON.stringify(merged, null, 2), "utf8");
    return true;
  } catch (_) {
    return false;
  }
}

/**
 * Generate Asitha API signature headers.
 */
export function createAsithaHeaders(bodyObj = {}, method = "POST", rawQuery = "", nonce = "") {
  const timestamp = Date.now().toString();
  const bodyStr = method === "GET" ? rawQuery : JSON.stringify(bodyObj);
  const payload = `${timestamp}.${nonce}.${bodyStr}`;
  const signature = crypto.createHmac("sha256", ASITHA_SIG_SECRET).update(payload).digest("hex");

  return {
    "x-signature": signature,
    "x-timestamp": timestamp,
    "x-nonce": nonce,
    "Content-Type": "application/json"
  };
}

/**
 * Fetch nonce from Asitha security endpoint.
 */
export async function fetchSecurityNonce(timeoutMs = 12000) {
  const resp = await fetch(`${ASITHA_API_BASE}/security/init`, {
    method: "GET",
    headers: { "User-Agent": "Mozilla/5.0" },
    signal: AbortSignal.timeout(timeoutMs)
  });
  if (!resp.ok) throw new Error(`Security init failed with HTTP ${resp.status}`);
  const data = await resp.json();
  if (!data?.nonce) throw new Error("Security init response did not contain nonce");
  return String(data.nonce);
}

/**
 * Safely exchange an hCaptcha token for an Asitha temp apiKey.
 */
export async function exchangeCaptchaForTempToken(captchaToken, timeoutMs = 15000) {
  if (!captchaToken || typeof captchaToken !== "string") {
    throw new Error("Missing or invalid captcha verification token");
  }
  const nonce = await fetchSecurityNonce(timeoutMs);
  const body = { recaptcha_token: captchaToken.trim() };
  const headers = createAsithaHeaders(body, "POST", "", nonce);

  const resp = await fetch(`${ASITHA_API_BASE}/user/get-temp-token`, {
    method: "POST",
    headers,
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(timeoutMs)
  });

  const data = await resp.json().catch(() => ({}));
  if (!resp.ok || !data?.token) {
    const msg = data?.message || `HTTP ${resp.status}`;
    throw new Error(`Captcha token exchange failed: ${msg}`);
  }
  return String(data.token);
}

/**
 * Solve hCaptcha using configured automated solver API (CapSolver, 2Captcha, AntiCaptcha).
 */
export async function solveCaptchaSafely(timeoutMs = 45000) {
  const capsolverKey = process.env.CAPSOLVER_API_KEY || process.env.CAP_SOLVER_KEY;
  if (capsolverKey) {
    // 1. CapSolver implementation
    const createResp = await fetch("https://api.capsolver.com/createTask", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        clientKey: capsolverKey,
        task: {
          type: "HCaptchaTaskProxyLess",
          websiteURL: HCAPTCHA_PAGE_URL,
          websiteKey: HCAPTCHA_SITEKEY
        }
      }),
      signal: AbortSignal.timeout(15000)
    });
    const createData = await createResp.json();
    if (createData.errorId && createData.errorId !== 0) {
      throw new Error(`CapSolver error: ${createData.errorDescription || "failed to create task"}`);
    }
    const taskId = createData.taskId;
    if (!taskId) throw new Error("CapSolver did not return taskId");

    const startTime = Date.now();
    while (Date.now() - startTime < timeoutMs) {
      await new Promise((r) => setTimeout(r, 2000));
      const resultResp = await fetch("https://api.capsolver.com/getTaskResult", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ clientKey: capsolverKey, taskId }),
        signal: AbortSignal.timeout(10000)
      });
      const resultData = await resultResp.json();
      if (resultData.status === "ready" && resultData.solution?.gRecaptchaResponse) {
        return resultData.solution.gRecaptchaResponse;
      }
      if (resultData.status === "failed" || (resultData.errorId && resultData.errorId !== 0)) {
        throw new Error(`CapSolver task failed: ${resultData.errorDescription || "unknown error"}`);
      }
    }
    throw new Error("CapSolver task timed out waiting for solution");
  }

  const twocaptchaKey = process.env.TWOCAPTCHA_API_KEY || process.env["2CAPTCHA_API_KEY"];
  if (twocaptchaKey) {
    // 2. 2Captcha implementation
    const inUrl = `https://2captcha.com/in.php?key=${twocaptchaKey}&method=hcaptcha&sitekey=${HCAPTCHA_SITEKEY}&pageurl=${encodeURIComponent(HCAPTCHA_PAGE_URL)}&json=1`;
    const inResp = await fetch(inUrl, { signal: AbortSignal.timeout(15000) });
    const inData = await inResp.json();
    if (inData.status !== 1) throw new Error(`2Captcha in error: ${inData.request || "failed to submit"}`);
    const reqId = inData.request;

    const startTime = Date.now();
    while (Date.now() - startTime < timeoutMs) {
      await new Promise((r) => setTimeout(r, 4000));
      const resUrl = `https://2captcha.com/res.php?key=${twocaptchaKey}&action=get&id=${reqId}&json=1`;
      const resResp = await fetch(resUrl, { signal: AbortSignal.timeout(10000) });
      const resData = await resResp.json();
      if (resData.status === 1 && resData.request) {
        return resData.request;
      }
      if (resData.request !== "CAPCHA_NOT_READY") {
        throw new Error(`2Captcha error: ${resData.request}`);
      }
    }
    throw new Error("2Captcha task timed out waiting for solution");
  }

  return null;
}

/**
 * Clean and unescape HTML entities in title.
 */
export function decodeHtmlEntities(str = "") {
  return str
    .replace(/&#x([0-9a-f]+);/gi, (_, h) => {
      try { return String.fromCodePoint(parseInt(h, 16)); } catch { return ""; }
    })
    .replace(/&#([0-9]+);/g, (_, d) => {
      try { return String.fromCodePoint(parseInt(d, 10)); } catch { return ""; }
    })
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, "\"")
    .replace(/&apos;/g, "'")
    .trim();
}

/**
 * Resolve WhatsApp Channel Name from link.
 */
export async function resolveChannelName(channelOrPostUrl, jwtToken = "", timeoutMs = 8000) {
  if (!channelOrPostUrl) return "";

  const m = channelOrPostUrl.match(/https?:\/\/(?:www\.)?whatsapp\.com\/channel\/([a-zA-Z0-9_-]+)/i);
  if (!m) return "";
  const channelCode = m[1];
  const channelBase = `https://whatsapp.com/channel/${channelCode}`;

  const isInvalid = (str) => {
    if (!str || typeof str !== "string") return true;
    const s = str.trim().toLowerCase();
    return s.length < 2 || /view update|channel update|whatsapp channel|^whatsapp$/i.test(s) || s.includes("whatsapp.com");
  };

  if (jwtToken) {
    try {
      const proxyUrl = `${ASITHA_API_BASE}/channel/metadata-proxy?url=${encodeURIComponent(channelBase)}`;
      const pr = await fetch(proxyUrl, {
        headers: {
          "User-Agent": "Mozilla/5.0",
          "Authorization": `Bearer ${jwtToken}`
        },
        signal: AbortSignal.timeout(timeoutMs)
      });
      if (pr.ok) {
        const pd = await pr.json();
        if (pd?.name && typeof pd.name === "string") {
          const decoded = decodeHtmlEntities(pd.name);
          if (!isInvalid(decoded)) return decoded;
        }
      }
    } catch (_) {}
  }

  try {
    const wr = await fetch(channelBase, {
      headers: {
        "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36",
        "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8"
      },
      signal: AbortSignal.timeout(timeoutMs)
    });
    if (wr.ok) {
      const html = await wr.text();
      const ogMatch = html.match(/<meta\s+property=[\"\']og:title[\"\']\s+content=[\"\']([^\"\']+)[\"\']/i)
        || html.match(/<meta\s+name=[\"\']title[\"\']\s+content=[\"\']([^\"\']+)[\"\']/i);
      if (ogMatch && ogMatch[1]) {
        const decoded = decodeHtmlEntities(ogMatch[1]);
        if (!isInvalid(decoded)) return decoded;
      }
      const titleTag = html.match(/<title>([^<]+)<\/title>/i);
      if (titleTag && titleTag[1]) {
        const tDecoded = decodeHtmlEntities(titleTag[1]).replace(/\s*\|\s*WhatsApp$/i, "").trim();
        if (!isInvalid(tDecoded)) return tDecoded;
      }
    }
  } catch (_) {}

  return "";
}

/**
 * Fetch Coin Balance from Asitha.
 */
export async function fetchCoinBalance(jwtOrApiKey, timeoutMs = 12000) {
  if (!jwtOrApiKey) {
    throw new Error("Asitha credentials not provided. Set ASITHA_JWT_TOKEN or ASITHA_API_KEY.");
  }
  const headers = {
    "User-Agent": "Mozilla/5.0",
    "Authorization": `Bearer ${jwtOrApiKey}`
  };
  const resp = await fetch(`${ASITHA_API_BASE}/auth/user`, {
    headers,
    signal: AbortSignal.timeout(timeoutMs)
  });
  const data = await resp.json().catch(() => ({}));
  if (!resp.ok) {
    throw new Error(data?.message || `HTTP ${resp.status} Unauthorized`);
  }
  const user = data.user || data;
  const coins = (typeof user.coin !== "undefined") ? user.coin : (user.coins ?? 0);
  return { user, coins };
}

/**
 * Main function to send reactions to channel post via Asitha.
 */
export async function sendChannelReactions({
  postLink,
  count = "all",
  reacts = DEFAULT_REACTIONS,
  apiKey = "",
  jwtToken = "",
  timeoutMs = 30000
}) {
  if (!postLink || !postLink.includes("whatsapp.com/channel/")) {
    throw new Error("Invalid channel post link. Must be a valid WhatsApp channel URL (e.g. https://whatsapp.com/channel/0029Vaa.../123)");
  }

  // 1. Resolve effective API Key
  let effectiveApiKey = apiKey;
  if (!effectiveApiKey) {
    const stored = getStoredAuth();
    effectiveApiKey = stored.apiKey;
    if (!jwtToken) jwtToken = stored.jwtToken;
  }

  // 2. If no API key, attempt safe automated captcha solving
  if (!effectiveApiKey) {
    try {
      const captchaToken = await solveCaptchaSafely();
      if (captchaToken) {
        effectiveApiKey = await exchangeCaptchaForTempToken(captchaToken);
        saveStoredAuth({ apiKey: effectiveApiKey });
      }
    } catch (solveErr) {
      console.log("[channelReaction] Auto-captcha notice:", solveErr.message);
    }
  }

  if (!effectiveApiKey) {
    throw new Error("Security verification required: Captcha verification or Asitha API key missing. Please configure ASITHA_API_KEY or CAPSOLVER_API_KEY, or run .reacttoken <token>.");
  }

  // 3. Obtain security nonce
  const nonce = await fetchSecurityNonce(timeoutMs);

  // 4. Construct request payload
  const body = {
    post_link: postLink.trim(),
    reacts: reacts || DEFAULT_REACTIONS,
    count: parseReactionCount(count)
  };

  // 5. Generate signed headers
  const headers = createAsithaHeaders(body, "POST", "", nonce);
  if (jwtToken) {
    headers["Authorization"] = `Bearer ${jwtToken}`;
  }

  // 6. Submit react-to-post request
  const submitUrl = `${ASITHA_API_BASE}/channel/react-to-post?apiKey=${encodeURIComponent(effectiveApiKey)}`;
  const resp = await fetch(submitUrl, {
    method: "POST",
    headers,
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(timeoutMs)
  });

  const resData = await resp.json().catch(() => ({}));
  if (!resp.ok) {
    const errText = resData?.message || `HTTP ${resp.status} Error sending reactions`;
    throw new Error(errText);
  }

  return {
    success: true,
    message: resData.message || "Reactions sent successfully!",
    count: body.count,
    reacts: body.reacts
  };
}

/**
 * Install Channel Reaction and Coin commands into the bot engine.
 */
export function installChannelReaction(ctx = {}) {
  const { cmd, sendReply, react, CONFIG, isOwner, isCreator, getSender } = ctx;
  if (typeof cmd !== "function") return false;

  const P = CONFIG?.PREFIX || ".";

  // Helper to verify creator/owner status
  function checkIsCreator(sock, msg) {
    if (!msg || !msg.key) return false;
    if (msg.key.fromMe) return true;
    let sender = "";
    if (typeof getSender === "function") {
      sender = getSender(msg);
    } else {
      sender = msg.key.participant || msg.key.remoteJid || "";
    }
    if (typeof isCreator === "function" && isCreator(sender)) return true;
    if (typeof isOwner === "function" && isOwner(sender)) return true;
    if (typeof globalThis.__miasIsOwner === "function" && globalThis.__miasIsOwner(sender)) return true;

    const senderClean = String(sender).split("@")[0].split(":")[0].replace(/[^0-9]/g, "");
    const envOwner = String(process.env.OWNER_NUMBER || process.env.OWNER || "").replace(/[^0-9]/g, "");
    if (envOwner && (envOwner === senderClean || envOwner.endsWith(senderClean) || senderClean.endsWith(envOwner))) {
      return true;
    }
    return false;
  }

  // Delayed reaction clear helper
  function delayedClearReact(sock, msg, delayMs = 2500) {
    setTimeout(async () => {
      try {
        if (typeof react === "function") {
          await react(sock, msg, "");
        } else if (sock && typeof sock.sendMessage === "function") {
          await sock.sendMessage(msg.key.remoteJid, { react: { text: "", key: msg.key } });
        }
      } catch (_) {}
    }, delayMs);
  }

  // 1. .reaction / .react command
  cmd(["react", "reaction", "massreact"], {
    desc: "Send bulk reactions to a WhatsApp channel post via Asitha — creator only",
    category: "CREATOR",
    ownerOnly: true,
    creatorOnly: true
  }, async (sock, msg, args = []) => {
    const jid = msg?.key?.remoteJid;
    if (!sock || !jid) return;

    // Check creator permission
    if (!checkIsCreator(sock, msg)) {
      if (typeof react === "function") await react(sock, msg, "❌").catch(() => {});
      delayedClearReact(sock, msg, 2500);
      const replyFn = typeof sendReply === "function" ? sendReply : (s, m, t) => s.sendMessage(jid, { text: t }, { quoted: m });
      await replyFn(sock, msg, "❌ This command is restricted to the bot creator only.");
      return;
    }

    const rawArgs = Array.isArray(args) ? args.join(" ").trim() : String(args).trim();
    const tokens = rawArgs.split(/\s+/).filter(Boolean);

    // If no URL provided, show usage help
    if (!tokens.length || !tokens[0].includes("whatsapp.com/channel/")) {
      const usage = `*Usage:* ${P}react <post-url> [mass|count] [emojis]\n*Example:* ${P}react https://whatsapp.com/channel/... mass`;
      const replyFn = typeof sendReply === "function" ? sendReply : (s, m, t) => s.sendMessage(jid, { text: t }, { quoted: m });
      await replyFn(sock, msg, usage);
      return;
    }

    const postUrl = tokens[0].trim();
    const rawQuantity = tokens[1] || "mass";
    const customEmojis = tokens.slice(2).join(" ").trim() || DEFAULT_REACTIONS;
    const countVal = parseReactionCount(rawQuantity);

    // Initial reaction: 🌀
    if (typeof react === "function") {
      await react(sock, msg, "🌀").catch(() => {});
    } else if (sock.sendMessage) {
      await sock.sendMessage(jid, { react: { text: "🌀", key: msg.key } }).catch(() => {});
    }

    const auth = getStoredAuth();
    const replyFn = typeof sendReply === "function" ? sendReply : (s, m, t) => s.sendMessage(jid, { text: t }, { quoted: m });

    // Resolve channel name
    const channelName = await resolveChannelName(postUrl, auth.jwtToken);

    // Send in-progress status message
    const targetLabel = channelName ? `*${channelName}*` : "channel";
    await replyFn(sock, msg, `🌀 Sending reactions to ${targetLabel} (${countVal === "all" ? "Maximum" : countVal + " bots"})...`).catch(() => {});

    try {
      const result = await sendChannelReactions({
        postLink: postUrl,
        count: countVal,
        reacts: customEmojis,
        apiKey: auth.apiKey,
        jwtToken: auth.jwtToken
      });

      // On Success: reaction ✅
      if (typeof react === "function") {
        await react(sock, msg, "✅").catch(() => {});
      } else if (sock.sendMessage) {
        await sock.sendMessage(jid, { react: { text: "✅", key: msg.key } }).catch(() => {});
      }
      delayedClearReact(sock, msg, 2500);

      const countLabel = result.count === "all" ? "Maximum" : `${result.count} reactions`;
      const doneLines = [
        "✅ *.sent*",
        "",
        `🎉 Successfully sent *${countLabel}*${channelName ? ` to *${channelName}*` : ""}!`,
        `• *Post:* ${postUrl}`,
        `• *Emojis:* ${result.reacts}`,
        "• *Deduction:* 1 Coin"
      ];
      const doneText = doneLines.join("\n");

      await replyFn(sock, msg, doneText);
    } catch (err) {
      // On Failure: reaction ❌
      if (typeof react === "function") {
        await react(sock, msg, "❌").catch(() => {});
      } else if (sock.sendMessage) {
        await sock.sendMessage(jid, { react: { text: "❌", key: msg.key } }).catch(() => {});
      }
      delayedClearReact(sock, msg, 3000);

      const errText = [
        `❌ *Failed to send reactions${channelName ? ` to ${channelName}` : ""}*`,
        "",
        `*Error:* ${err.message || "Unknown error"}`,
        "",
        `_Tip: Check coin balance with ${P}coin or set key with ${P}reacttoken <key>_`
      ].join("\n");

      await replyFn(sock, msg, errText);
    }
  });

  // 2. .coin / .coins command
  cmd(["coin", "coins", "checkcoin", "asithacoin"], {
    desc: "Check Asitha Channel Manager coin balance — creator only",
    category: "CREATOR",
    ownerOnly: true,
    creatorOnly: true
  }, async (sock, msg) => {
    const jid = msg?.key?.remoteJid;
    if (!sock || !jid) return;

    if (!checkIsCreator(sock, msg)) {
      if (typeof react === "function") await react(sock, msg, "❌").catch(() => {});
      delayedClearReact(sock, msg, 2500);
      const replyFn = typeof sendReply === "function" ? sendReply : (s, m, t) => s.sendMessage(jid, { text: t }, { quoted: m });
      await replyFn(sock, msg, "❌ This command is restricted to the bot creator only.");
      return;
    }

    if (typeof react === "function") {
      await react(sock, msg, "🌀").catch(() => {});
    }

    const replyFn = typeof sendReply === "function" ? sendReply : (s, m, t) => s.sendMessage(jid, { text: t }, { quoted: m });
    const auth = getStoredAuth();
    const token = auth.jwtToken || auth.apiKey;

    try {
      const { user, coins } = await fetchCoinBalance(token);

      if (typeof react === "function") {
        await react(sock, msg, "✅").catch(() => {});
      }
      delayedClearReact(sock, msg, 2500);

      const coinMsg = [
        "🪙 *COIN BALANCE*",
        "",
        `• *Account:* *${user.email || user.username || user.name || "Creator"}*`,
        `• *Balance:* *${coins}* COINS`,
        "• *Service:* WhatsApp Channel Reactions",
        "• *Rate:* 1 Coin per request (up to Maximum / All Bots)",
        "",
        `_Send reactions with ${P}react <channel-post-link> mass_`
      ].join("\n");

      await replyFn(sock, msg, coinMsg);
    } catch (err) {
      if (typeof react === "function") {
        await react(sock, msg, "❌").catch(() => {});
      }
      delayedClearReact(sock, msg, 3000);

      const errText = [
        "❌ *Could not fetch coin balance*",
        "",
        `*Reason:* ${err.message}`,
        "",
        `_To authenticate, set ASITHA_API_KEY in config or run ${P}reacttoken <key>_`
      ].join("\n");

      await replyFn(sock, msg, errText);
    }
  });

  // 3. .reacttoken / .asithatoken helper to set token directly via WhatsApp
  cmd(["reacttoken", "asithatoken", "reactkey"], {
    desc: "Set or update Asitha API key / JWT token — creator only",
    category: "CREATOR",
    ownerOnly: true,
    creatorOnly: true
  }, async (sock, msg, args = []) => {
    const jid = msg?.key?.remoteJid;
    if (!sock || !jid) return;

    if (!checkIsCreator(sock, msg)) {
      return;
    }

    const token = Array.isArray(args) ? args.join(" ").trim() : String(args).trim();
    const replyFn = typeof sendReply === "function" ? sendReply : (s, m, t) => s.sendMessage(jid, { text: t }, { quoted: m });

    if (!token) {
      await replyFn(sock, msg, `🔑 *Usage:* ${P}reacttoken <api-key-or-jwt-token>`);
      return;
    }

    // Save token
    const isJwt = token.startsWith("eyJ") || token.length > 80;
    saveStoredAuth(isJwt ? { jwtToken: token } : { apiKey: token });

    if (typeof react === "function") await react(sock, msg, "✅").catch(() => {});
    delayedClearReact(sock, msg, 2500);

    await replyFn(sock, msg, "✅ *Token saved successfully!* You can now run " + P + "coin and " + P + "react.");
  });

  return true;
}
