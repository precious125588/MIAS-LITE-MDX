/**
 * AI helpers for Levanter plugins in MIAS:
 * - nixResponse: Handles chat with Levanter chat endpoint & smart bot responses
 * - groqResponse: Groq API client with fallback
 * - openRouter: OpenRouter API client
 * - getDallEResponse: Levanter image generation with reliable fallback
 */
import axios from "axios";

const BOT_ABOUT_REGEX = /(?:who\s+are\s+you|what\s+is\s+this\s+bot|what\s+can\s+you\s+do|about\s+(?:the\s+)?bot|tell\s+me\s+about\s+yourself|\bmias\b)/i;

export async function nixResponse(message, id = "0") {
  const query = String(message || "").trim();
  if (!query) return "How can I help you today?";

  if (BOT_ABOUT_REGEX.test(query)) {
    return "I am MIAS, an advanced WhatsApp multi-device bot created to assist, protect groups, manage commands, download media, and provide smart AI responses. How can I help you today?";
  }

  // 1. Try Levanter official endpoint
  try {
    const res = await axios.post(
      "https://levanter.onrender.com/chat",
      { message: query, id: String(id) },
      { timeout: 9000, headers: { "Content-Type": "application/json" } }
    );
    if (res.data && res.data.result) {
      return res.data.result;
    }
  } catch (err) {
    // fallback below
  }

  // 2. Fallback to free chat endpoint
  try {
    const res = await axios.get(
      `https://api.nexray.site/ai/gpt4?prompt=${encodeURIComponent(query)}`,
      { timeout: 7000 }
    );
    if (res.data?.result) return res.data.result;
  } catch {}

  return "I'm here! What would you like to know or do?";
}

export async function groqResponse(prompt, id = "0") {
  const apiKey = process.env.GROQ_API_KEY || "";
  const model = process.env.GROQ_MODEL || "llama-3.3-70b-versatile";

  if (apiKey) {
    try {
      const res = await axios.post(
        "https://api.groq.com/openai/v1/chat/completions",
        {
          model,
          messages: [
            { role: "system", content: process.env.GROQ_SYSTEM_MSG || "You are a helpful assistant." },
            { role: "user", content: prompt }
          ]
        },
        {
          headers: {
            Authorization: `Bearer ${apiKey}`,
            "Content-Type": "application/json"
          },
          timeout: 15000
        }
      );
      return res.data?.choices?.[0]?.message?.content || "";
    } catch (err) {
      // fallback
    }
  }

  // Fallback to free AI
  try {
    const res = await axios.get(
      `https://api.nexray.site/ai/gpt4?prompt=${encodeURIComponent(prompt)}`,
      { timeout: 9000 }
    );
    if (res.data?.result) return res.data.result;
  } catch {}

  return "Groq response unavailable. Please configure GROQ_API_KEY.";
}

export async function openRouter(prompt, id = "0") {
  const apiKey = process.env.OPENROUTER_API_KEY || "";
  const model = process.env.OPENROUTER_MODEL || "meta-llama/llama-3.1-8b-instruct:free";

  if (apiKey) {
    try {
      const res = await axios.post(
        "https://openrouter.ai/api/v1/chat/completions",
        {
          model,
          messages: [
            { role: "system", content: process.env.OPENROUTER_SYSTEM_MSG || "You are a helpful assistant." },
            { role: "user", content: prompt }
          ]
        },
        {
          headers: {
            Authorization: `Bearer ${apiKey}`,
            "HTTP-Referer": "https://github.com/lyfe00011/levanter",
            "X-Title": "Levanter",
            "Content-Type": "application/json"
          },
          timeout: 15000
        }
      );
      return res.data?.choices?.[0]?.message?.content || "";
    } catch (err) {
      // fallback
    }
  }

  // Fallback
  try {
    const res = await axios.get(
      `https://api.nexray.site/ai/gpt4?prompt=${encodeURIComponent(prompt)}`,
      { timeout: 9000 }
    );
    if (res.data?.result) return res.data.result;
  } catch {}

  return "OpenRouter response unavailable. Please configure OPENROUTER_API_KEY.";
}

export async function getDallEResponse(prompt, id = "0") {
  const cleanPrompt = encodeURIComponent(String(prompt || "").trim());

  // 1. Try Levanter Nekolabs endpoint
  try {
    const res = await axios.get(
      `https://api.nekolabs.web.id/image-generation/imagen/4.0-fast?prompt=${cleanPrompt}`,
      { timeout: 8000 }
    );
    const url = res.data?.url || res.data?.result || (typeof res.data === "string" ? res.data : null);
    if (url && url.startsWith("http")) return url;
  } catch {}

  // 2. Pollinations.ai instant reliable fallback
  return `https://image.pollinations.ai/prompt/${cleanPrompt}`;
}
