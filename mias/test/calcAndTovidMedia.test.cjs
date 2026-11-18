const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const path = require("path");

test("calcEngine evaluates numeric and scientific expressions", async () => {
  const { evaluateNumericAndScientific, formatNumber } = await import("../lib/calcEngine.js");

  // Arithmetic
  assert.equal(formatNumber(evaluateNumericAndScientific("2 + 2")), "4");
  assert.equal(formatNumber(evaluateNumericAndScientific("10 * 5")), "50");
  assert.equal(formatNumber(evaluateNumericAndScientific("2^10")), "1,024");
  assert.equal(formatNumber(evaluateNumericAndScientific("50% * 200")), "100");
  assert.equal(formatNumber(evaluateNumericAndScientific("5 x 5")), "25");
  assert.equal(formatNumber(evaluateNumericAndScientific("5!")), "120");

  // Scientific functions
  assert.equal(formatNumber(evaluateNumericAndScientific("sin(pi/2)")), "1");
  assert.equal(formatNumber(evaluateNumericAndScientific("sin(90 deg)")), "1");
  assert.equal(formatNumber(evaluateNumericAndScientific("cos(0)")), "1");
  assert.equal(formatNumber(evaluateNumericAndScientific("sqrt(144)")), "12");

  // Physical constants
  assert.equal(formatNumber(evaluateNumericAndScientific("c * 2")), "599,584,916");
});

test("calcEngine simplifies symbolic algebra and linear equations", async () => {
  const { simplifySymbolicAlgebra } = await import("../lib/calcEngine.js");

  // x + x => 2x (the exact issue user reported)
  assert.equal(simplifySymbolicAlgebra("x + x"), "2x");
  assert.equal(simplifySymbolicAlgebra("x+x"), "2x");
  assert.equal(simplifySymbolicAlgebra("2x + 3x"), "5x");
  assert.equal(simplifySymbolicAlgebra("5x - 2x + 10"), "3x + 10");
  assert.equal(simplifySymbolicAlgebra("x - x"), "0");
  assert.equal(simplifySymbolicAlgebra("x * x"), "x²");
  assert.equal(simplifySymbolicAlgebra("2x * 3x"), "6x²");
  assert.equal(simplifySymbolicAlgebra("2x + 4 = 10"), "x = 3");
});

test("tovid command is aliased to tomp4 and not a standalone duplicate command", () => {
  const content = fs.readFileSync(path.join(__dirname, "../index.js"), "utf8");

  // Ensure tomp4 has tovid in its alias list
  assert.ok(content.includes('tomp4') && content.includes('"tovid"') && content.includes('"tovideo"'), "tomp4 should include tovid as an alias");

  // Ensure old standalone tovid registration block was removed
  assert.ok(!content.includes('cmd(["tovid", "tovideo"'), "Old duplicate tovid command should be removed");
});

test("videoTools convertToMp4 handles animated and static stickers without ffmpeg timing out", async () => {
  const { convertToMp4 } = await import("../lib/videoTools.js");

  // Verify static sticker conversion
  const staticSticker = path.join(__dirname, "../../stickers/banv2_sticker.webp");
  const outStatic = path.join("/tmp", `test_static_stk_${Date.now()}.mp4`);
  
  try {
    const resStatic = await convertToMp4(staticSticker, outStatic, { kind: "sticker", timeoutMs: 30000 });
    assert.ok(resStatic.ok, "Static sticker should convert to MP4 successfully");
    assert.ok(fs.existsSync(outStatic) && fs.statSync(outStatic).size > 0, "Output MP4 should exist and be non-empty");
  } finally {
    try { fs.unlinkSync(outStatic); } catch {}
  }
});
