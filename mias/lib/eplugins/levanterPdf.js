/**
 * Page & Multi-page PDF creator for Levanter plugins in MIAS
 * Compiles replied image pages into an A4 PDF document using pdfkit
 */
import fs from "fs-extra";
import path from "path";
import os from "os";

const PDF_TEMP_ROOT = path.join(os.tmpdir(), "mias_levanter_pdf");

function getUserPdfDir(userKey) {
  const safeKey = String(userKey || "default").replace(/[^a-zA-Z0-9_-]/g, "_");
  const dir = path.join(PDF_TEMP_ROOT, safeKey);
  fs.ensureDirSync(dir);
  return dir;
}

export async function savePage(userKey, pageNum, imageBuffer) {
  const dir = getUserPdfDir(userKey);
  const safeNum = String(pageNum || Date.now()).padStart(4, "0");
  const filePath = path.join(dir, `page_${safeNum}.jpg`);
  await fs.writeFile(filePath, imageBuffer);
  return filePath;
}

export function hasPages(userKey) {
  const dir = getUserPdfDir(userKey);
  if (!fs.existsSync(dir)) return false;
  const files = fs.readdirSync(dir).filter(f => f.startsWith("page_"));
  return files.length > 0;
}

export function getSavedPageCount(userKey) {
  const dir = getUserPdfDir(userKey);
  if (!fs.existsSync(dir)) return 0;
  return fs.readdirSync(dir).filter(f => f.startsWith("page_")).length;
}

export async function toPdf(userKey, title = "Document") {
  const dir = getUserPdfDir(userKey);
  if (!fs.existsSync(dir)) {
    throw new Error("Not added pages, Use page command");
  }
  const files = fs.readdirSync(dir).filter(f => f.startsWith("page_")).sort();
  if (files.length === 0) {
    throw new Error("Not added pages, Use page command");
  }

  const PDFDocument = (await import("pdfkit")).default;
  const doc = new PDFDocument({ autoFirstPage: false, margin: 0 });
  const chunks = [];

  doc.on("data", chunk => chunks.push(chunk));

  for (const file of files) {
    const filePath = path.join(dir, file);
    const imgBuf = await fs.readFile(filePath);
    doc.addPage({ size: "A4" });
    // Fit image on A4 page (595.28 x 841.89 points)
    doc.image(imgBuf, 0, 0, { width: 595.28, height: 841.89, fit: [595.28, 841.89], align: "center", valign: "center" });
  }

  doc.end();

  const buffer = await new Promise((resolve, reject) => {
    doc.on("end", () => resolve(Buffer.concat(chunks)));
    doc.on("error", reject);
  });

  // Clean up temp images
  try {
    await fs.remove(dir);
  } catch {}

  return buffer;
}
