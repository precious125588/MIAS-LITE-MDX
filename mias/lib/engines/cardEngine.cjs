"use strict";

const { renderCard, roundedRect } = require("./canvasEngine.cjs");

function text(ctx, value, x, y, options = {}) {
  ctx.fillStyle = options.color || "#ffffff";
  ctx.font = options.font || "600 32px sans-serif";
  ctx.textAlign = options.align || "left";
  ctx.textBaseline = options.baseline || "alphabetic";
  ctx.fillText(String(value || ""), x, y, options.maxWidth);
}

function lineWrap(ctx, value, maxWidth, maxLines = 3) {
  const words = String(value || "").split(/\s+/);
  const lines = [];
  let line = "";
  for (const word of words) {
    const next = line ? `${line} ${word}` : word;
    if (ctx.measureText(next).width > maxWidth && line) {
      lines.push(line);
      line = word;
      if (lines.length === maxLines) break;
    } else line = next;
  }
  if (line && lines.length < maxLines) lines.push(line);
  return lines;
}

async function createNamedCard(kind, options = {}) {
  const card = await renderCard({
    ...options,
    width: options.width || 1200,
    height: options.height || 630,
    image: options.image || options.thumbnail || options.avatar,
  });
  const { ctx, width, height } = card;
  const left = options.image || options.thumbnail || options.avatar ? 390 : 88;
  text(ctx, options.eyebrow || kind.toUpperCase(), left, 132, { font: "700 22px sans-serif", color: options.accent || "#a5b4fc" });
  text(ctx, options.title || "MIAS", left, 214, { font: "700 58px sans-serif", maxWidth: width - left - 80 });
  ctx.font = "400 28px sans-serif";
  const lines = lineWrap(ctx, options.subtitle || options.description || "", width - left - 100, 4);
  lines.forEach((line, index) => text(ctx, line, left, 282 + index * 42, { font: "400 28px sans-serif", color: "rgba(255,255,255,0.78)" }));
  if (options.footer) text(ctx, options.footer, left, height - 94, { font: "600 22px sans-serif", color: "rgba(255,255,255,0.58)" });
  return card.buffer();
}

const createThumbnailCard = (options) => createNamedCard("thumbnail", options);
const createProfileCard = (options) => createNamedCard("profile", options);
const createHeroCard = (options) => createNamedCard("hero", options);
const createMusicCard = (options) => createNamedCard("music", options);
const createRankCard = (options) => createNamedCard("rank", options);
const createMenuCard = (options) => createNamedCard("menu", options);
const createWelcomeCard = (options) => createNamedCard("welcome", options);
const createGoodbyeCard = (options) => createNamedCard("goodbye", options);
const createDashboardCard = (options) => createNamedCard("dashboard", options);
const createAiCard = (options) => createNamedCard("ai", options);

module.exports = {
  createAiCard,
  createDashboardCard,
  createGoodbyeCard,
  createHeroCard,
  createMenuCard,
  createMusicCard,
  createNamedCard,
  createProfileCard,
  createRankCard,
  createThumbnailCard,
  createWelcomeCard,
};