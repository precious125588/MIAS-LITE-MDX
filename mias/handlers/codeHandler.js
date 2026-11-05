/**
 * MIAS — Code Handler
 *
 * Sends beautifully formatted code snippets as WhatsApp messages.
 * Supports syntax labeling and document fallback for long code.
 *
 * Architecture:  Commands → Handlers → Baileys Adapter → WhatsApp
 */

import { sendText } from "./messageHandler.js";
import { sendDocument } from "./mediaHandler.js";

// ─── Language display names ────────────────────────────────────────────────────

const LANG_LABELS = {
  js: "JavaScript", javascript: "JavaScript",
  ts: "TypeScript", typescript: "TypeScript",
  py: "Python", python: "Python",
  rb: "Ruby", ruby: "Ruby",
  go: "Go", golang: "Go",
  rs: "Rust", rust: "Rust",
  cpp: "C++", c: "C",
  cs: "C#", csharp: "C#",
  java: "Java",
  php: "PHP",
  sh: "Shell", bash: "Bash",
  html: "HTML", css: "CSS",
  json: "JSON",
  yaml: "YAML", yml: "YAML",
  sql: "SQL",
  md: "Markdown", markdown: "Markdown",
  xml: "XML",
  kt: "Kotlin", kotlin: "Kotlin",
  swift: "Swift",
  dart: "Dart",
  lua: "Lua",
  r: "R",
  scala: "Scala",
  elixir: "Elixir",
  haskell: "Haskell",
  perl: "Perl",
};

const LANG_EXTENSIONS = {
  javascript: "js", typescript: "ts", python: "py", ruby: "rb",
  go: "go", rust: "rs", cpp: "cpp", c: "c", csharp: "cs",
  java: "java", php: "php", bash: "sh", shell: "sh", html: "html",
  css: "css", json: "json", yaml: "yaml", sql: "sql",
  markdown: "md", xml: "xml", kotlin: "kt", swift: "swift",
  dart: "dart", lua: "lua",
};

// ─── Internal formatters ───────────────────────────────────────────────────────

function _buildCodeBlock(code, lang, title) {
  const label = LANG_LABELS[lang?.toLowerCase()] || (lang ? lang.toUpperCase() : "CODE");
  const border = "═".repeat(40);
  const header = title ? `*${title}*\n` : "";
  return [
    header,
    `\`\`\`${label}\n${code}\n\`\`\``,
  ].filter(Boolean).join("");
}

function _getExtension(lang) {
  return LANG_EXTENSIONS[lang?.toLowerCase()] || lang?.toLowerCase() || "txt";
}

// ─── Public API ───────────────────────────────────────────────────────────────

/**
 * Send a code block as a WhatsApp message.
 * For long code (>3000 chars), sends as a downloadable document.
 *
 * @param {object} sock
 * @param {string} jid
 * @param {string} code         - The code to send
 * @param {object} [opts]
 * @param {string} [opts.lang]          - Language name (e.g. "js", "python")
 * @param {string} [opts.title]         - Optional title above the code block
 * @param {string} [opts.footer]        - Text appended below the block
 * @param {object} [opts.quoted]        - Quote a message
 * @param {boolean}[opts.forceDocument] - Always send as a document
 * @param {string} [opts.filename]      - Override filename for document
 * @returns {Promise<object|null>}
 */
export async function sendCode(sock, jid, code, opts = {}) {
  const { lang, title, footer, quoted, forceDocument = false, filename } = opts;

  const codeStr = String(code || "");
  const ext = _getExtension(lang);
  const fname = filename || `code.${ext}`;

  // Long code → document
  if (forceDocument || codeStr.length > 3000) {
    const buf = Buffer.from(codeStr, "utf8");
    const label = LANG_LABELS[lang?.toLowerCase()] || (lang || "Code").toUpperCase();
    return sendDocument(sock, jid, buf, {
      mimetype: "text/plain",
      filename: fname,
      caption: title ? `*${title}*${footer ? "\n" + footer : ""}` : (footer || ""),
      quoted,
    });
  }

  // Short code → formatted text
  const formatted = _buildCodeBlock(codeStr, lang, title);
  const full = footer ? `${formatted}\n\n${footer}` : formatted;
  return sendText(sock, jid, full, { quoted });
}

/**
 * Send multiple code snippets (multi-file viewer).
 *
 * @param {object}   sock
 * @param {string}   jid
 * @param {object[]} snippets  - [{code, lang, title}]
 * @param {object}   [opts]
 * @param {string}   [opts.header]  - Text before all snippets
 * @param {object}   [opts.quoted]
 * @returns {Promise<void>}
 */
export async function sendCodeMulti(sock, jid, snippets, opts = {}) {
  const { header, quoted } = opts;
  const parts = snippets.map(s => _buildCodeBlock(s.code || "", s.lang, s.title));
  const full = [header, ...parts].filter(Boolean).join("\n\n");

  if (full.length > 3000) {
    // Send each snippet individually as documents
    for (const s of snippets) {
      await sendCode(sock, jid, s.code, {
        lang: s.lang, title: s.title, forceDocument: true, quoted,
      });
    }
  } else {
    await sendText(sock, jid, full, { quoted });
  }
}
