"use strict";

const { getLinkPreview } = require("link-preview-js");
const dns = require("node:dns").promises;

const URL_PATTERN = /https?:\/\/[^\s<>"']+/i;

function extractUrl(text) {
  const match = String(text || "").match(URL_PATTERN);
  return match ? match[0].replace(/[),.;!?]+$/, "") : null;
}

async function resolveDNSHost(input) {
  const hostname = new URL(input).hostname.replace(/^\[|\]$/g, "");
  const result = await dns.lookup(hostname, { all: false, verbatim: true });
  return result.address;
}

function allowSameHostRedirect(baseURL, forwardedURL) {
  try {
    const base = new URL(baseURL);
    const forwarded = new URL(forwardedURL);
    const baseHost = base.hostname.replace(/^www\./i, "").toLowerCase();
    const forwardedHost = forwarded.hostname.replace(/^www\./i, "").toLowerCase();
    return baseHost === forwardedHost
      && (forwarded.protocol === base.protocol
        || (base.protocol === "http:" && forwarded.protocol === "https:"));
  } catch {
    return false;
  }
}

async function previewLink(input, options = {}) {
  const url = extractUrl(input) || String(input || "");
  if (!/^https?:\/\//i.test(url)) throw new TypeError("previewLink requires an HTTP(S) URL or text containing one");
  const preview = await getLinkPreview(url, {
    timeout: options.timeout || 10_000,
    followRedirects: "manual",
    handleRedirects: allowSameHostRedirect,
    resolveDNSHost,
    headers: {
      "user-agent": options.userAgent || "MIAS Link Preview/1.0",
      ...(options.headers || {}),
    },
  });
  return {
    url: preview.url || url,
    title: preview.title || "",
    description: preview.description || "",
    siteName: preview.siteName || "",
    author: preview.author || "",
    thumbnail: preview.images?.[0] || null,
    images: Array.isArray(preview.images) ? preview.images : [],
    videos: Array.isArray(preview.videos) ? preview.videos : [],
    favicons: Array.isArray(preview.favicons) ? preview.favicons : [],
    mediaType: preview.mediaType || "unknown",
    contentType: preview.contentType || null,
  };
}

module.exports = { extractUrl, previewLink };