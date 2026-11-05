"use strict";

function getCanvas() {
  try {
    return { backend: "@napi-rs/canvas", module: require("@napi-rs/canvas") };
  } catch (napiError) {
    try {
      return { backend: "canvas", module: require("canvas") };
    } catch (canvasError) {
      const error = new Error(
        `MIAS canvas engine is unavailable. @napi-rs/canvas: ${napiError.message}; canvas: ${canvasError.message}`,
      );
      error.cause = canvasError;
      throw error;
    }
  }
}

function clamp(value, min, max) {
  return Math.max(min, Math.min(max, Number(value)));
}

function roundedRect(ctx, x, y, width, height, radius) {
  const r = clamp(radius, 0, Math.min(width, height) / 2);
  ctx.beginPath();
  ctx.roundRect(x, y, width, height, r);
  ctx.closePath();
}

function drawGradient(ctx, width, height, colors = ["#111827", "#312e81"]) {
  const gradient = ctx.createLinearGradient(0, 0, width, height);
  colors.forEach((color, index) => gradient.addColorStop(index / Math.max(1, colors.length - 1), color));
  ctx.fillStyle = gradient;
  ctx.fillRect(0, 0, width, height);
}

function drawGlass(ctx, x, y, width, height, options = {}) {
  roundedRect(ctx, x, y, width, height, options.radius || 24);
  ctx.fillStyle = options.fill || "rgba(255,255,255,0.12)";
  ctx.fill();
  if (options.stroke) {
    ctx.strokeStyle = options.stroke;
    ctx.lineWidth = options.lineWidth || 1;
    ctx.stroke();
  }
}

async function loadImage(input) {
  if (!input) return null;
  const { module: canvasModule } = getCanvas();
  const { loadImage: load } = canvasModule;
  return load(input);
}

async function renderCard(options = {}) {
  const width = clamp(options.width || 1200, 240, 3000);
  const height = clamp(options.height || 630, 180, 3000);
  const scale = clamp(options.scale || 1, 1, 3);
  const { module: canvasModule } = getCanvas();
  const { createCanvas } = canvasModule;
  const canvas = createCanvas(Math.round(width * scale), Math.round(height * scale));
  const ctx = canvas.getContext("2d");
  ctx.scale(scale, scale);
  drawGradient(ctx, width, height, options.colors);
  if (options.glass !== false) drawGlass(ctx, 28, 28, width - 56, height - 56, { stroke: "rgba(255,255,255,0.18)" });
  if (options.image) {
    const image = await loadImage(options.image);
    const size = Math.min(height - 100, options.imageSize || 260);
    const x = options.imageX === undefined ? 62 : options.imageX;
    const y = options.imageY === undefined ? (height - size) / 2 : options.imageY;
    ctx.save();
    roundedRect(ctx, x, y, size, size, options.imageRadius || 28);
    ctx.clip();
    ctx.drawImage(image, x, y, size, size);
    ctx.restore();
  }
  return { canvas, ctx, width, height, buffer: () => canvas.toBuffer("image/png") };
}

module.exports = { clamp, drawGlass, drawGradient, getCanvas, loadImage, renderCard, roundedRect };