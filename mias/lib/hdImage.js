import sharp from "sharp";

export const HD_IMAGE_WIDTH = 2080;
export const IMAGE_CREDIT_CAPTION = "made by 𝑷𝑹𝑬𝑪𝑰𝑶𝑼𝑺 x";

export function imageGalleryCaption(index, total) {
  return index === total - 1 ? IMAGE_CREDIT_CAPTION : undefined;
}

export async function prepareHdImage(input, { width = HD_IMAGE_WIDTH, quality = 95 } = {}) {
  if (!Buffer.isBuffer(input) || input.length < 500) throw new Error("Invalid image buffer");
  const source = sharp(input, { failOn: "error" });
  const metadata = await source.metadata();
  if (!metadata.width || !metadata.height) throw new Error("Image dimensions unavailable");
  if (metadata.width >= width) {
    return { buffer: input, width: metadata.width, height: metadata.height, upscaled: false };
  }
  const buffer = await sharp(input)
    .resize({ width, withoutEnlargement: false, fit: "inside" })
    .webp({ quality })
    .toBuffer();
  const output = await sharp(buffer).metadata();
  return {
    buffer,
    width: output.width || width,
    height: output.height || 0,
    upscaled: true,
  };
}