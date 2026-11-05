"use strict";

function renderSvgToPng(svg, options = {}) {
  if (typeof svg !== "string" && !Buffer.isBuffer(svg)) throw new TypeError("SVG must be a string or Buffer");
  const { Resvg } = require("@resvg/resvg-js");
  const renderer = new Resvg(svg, {
    fitTo: options.width ? { mode: "width", value: Number(options.width) } :
      options.height ? { mode: "height", value: Number(options.height) } : { mode: "original" },
    background: options.background,
    logLevel: options.logLevel || "off",
    font: options.font,
  });
  return renderer.render().asPng();
}

async function renderSvgToPngAsync(svg, options = {}) {
  if (typeof svg !== "string" && !Buffer.isBuffer(svg)) throw new TypeError("SVG must be a string or Buffer");
  const { renderAsync } = require("@resvg/resvg-js");
  const rendered = await renderAsync(svg, {
    fitTo: options.width ? { mode: "width", value: Number(options.width) } :
      options.height ? { mode: "height", value: Number(options.height) } : { mode: "original" },
    background: options.background,
    logLevel: options.logLevel || "off",
    font: options.font,
  });
  return rendered.asPng();
}

module.exports = { renderSvgToPng, renderSvgToPngAsync };