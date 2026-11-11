const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const me = require("../features/mediaEnhance.cjs");
const v39 = require("../precious-fixes-v39.cjs");

test("remux command is removed from splitVideo.js and excluded in menus", () => {
  const splitContent = fs.readFileSync(path.join(__dirname, "../features/splitVideo.js"), "utf8");
  assert.ok(!splitContent.includes('cmd(["remux"]'), "splitVideo.js should not contain cmd(['remux'])");

  const menuContent = fs.readFileSync(path.join(__dirname, "../lib/premiumMenus.js"), "utf8");
  assert.ok(menuContent.includes("remux"), "premiumMenus.js should exclude remux");

  const commands = new Map();
  commands.set("remux", { handler: () => {} });
  v39({ commands });
  assert.equal(commands.has("remux"), false, "v39 should delete remux from commands map");
});

test("v39 registers 4k, hd and their respective aliases", () => {
  const commands = new Map();
  v39({ commands });

  for (const name of ["4k", "uhd", "4kvideo", "remini4k"]) {
    assert.ok(commands.has(name), `Expected commands to have 4K command or alias '${name}'`);
    assert.equal(typeof commands.get(name).handler, "function");
  }

  for (const name of ["hd", "hdvideo", "hd-video", "tthd"]) {
    assert.ok(commands.has(name), `Expected commands to have HD command or alias '${name}'`);
    assert.equal(typeof commands.get(name).handler, "function");
  }
});

test("mediaEnhance URL classification", () => {
  assert.ok(me.isTikTokUrl("https://www.tiktok.com/@user/video/7123456789012345678"));
  assert.ok(me.isTikTokUrl("https://vm.tiktok.com/ZM812345/"));
  assert.ok(!me.isTikTokUrl("https://example.com/video.mp4"));

  assert.ok(me.isVideoUrl("https://example.com/stream.mp4"));
  assert.ok(me.isVideoUrl("https://example.com/video.webm?auth=abc"));
  assert.ok(!me.isVideoUrl("https://example.com/image.jpg"));

  assert.ok(me.isImageUrl("https://example.com/photo.jpg"));
  assert.ok(me.isImageUrl("https://example.com/photo.png?size=large"));
  assert.ok(!me.isImageUrl("https://example.com/video.mp4"));
});

test("mediaEnhance extractMediaFromMsg extracts quoted and direct media across wrappers", () => {
  // Quoted image
  const quotedImgMsg = {
    message: {
      extendedTextMessage: {
        text: "hd",
        contextInfo: {
          quotedMessage: {
            imageMessage: { mimetype: "image/jpeg" }
          }
        }
      }
    }
  };
  const extractedImg = me.extractMediaFromMsg(quotedImgMsg);
  assert.ok(extractedImg);
  assert.equal(extractedImg.kind, "image");
  assert.equal(extractedImg.isQuoted, true);

  // Quoted video
  const quotedVidMsg = {
    message: {
      extendedTextMessage: {
        text: "4k",
        contextInfo: {
          quotedMessage: {
            videoMessage: { mimetype: "video/mp4" }
          }
        }
      }
    }
  };
  const extractedVid = me.extractMediaFromMsg(quotedVidMsg);
  assert.ok(extractedVid);
  assert.equal(extractedVid.kind, "video");
  assert.equal(extractedVid.isQuoted, true);

  // Direct image with caption
  const directImgMsg = {
    message: {
      imageMessage: {
        caption: ".hd",
        mimetype: "image/jpeg"
      }
    }
  };
  const extractedDirect = me.extractMediaFromMsg(directImgMsg);
  assert.ok(extractedDirect);
  assert.equal(extractedDirect.kind, "image");
  assert.equal(extractedDirect.isQuoted, false);
});

test("executeMediaEnhance reacts ❌ and sends usage when no media or link is present", async () => {
  const reactions = [];
  const replies = [];

  const mockSock = {
    sendMessage: async (jid, payload) => {
      if (payload.react) reactions.push(payload.react.text);
      if (payload.text) replies.push(payload.text);
    }
  };
  const mockMsg = {
    key: { remoteJid: "1234567890@s.whatsapp.net" },
    message: { conversation: "4k" }
  };

  await me.executeMediaEnhance(mockSock, mockMsg, [], "4k");

  assert.ok(reactions.includes("🌀"), "Expected initial 🌀 reaction");
  assert.ok(reactions.includes("❌"), "Expected failure ❌ reaction");
  assert.ok(replies.some(r => r.includes("4K Ultra HD Enhancement")), "Expected 4K usage reply");
});

test("executeMediaEnhance HD reacts ❌ and sends usage when no media or link is present", async () => {
  const reactions = [];
  const replies = [];

  const mockSock = {
    sendMessage: async (jid, payload) => {
      if (payload.react) reactions.push(payload.react.text);
      if (payload.text) replies.push(payload.text);
    }
  };
  const mockMsg = {
    key: { remoteJid: "1234567890@s.whatsapp.net" },
    message: { conversation: "hd" }
  };

  await me.executeMediaEnhance(mockSock, mockMsg, [], "hd");

  assert.ok(reactions.includes("🌀"), "Expected initial 🌀 reaction");
  assert.ok(reactions.includes("❌"), "Expected failure ❌ reaction");
  assert.ok(replies.some(r => r.includes("HD 1080p Re-encode")), "Expected HD usage reply");
});

test("executeMediaEnhance processes image with 🌀 -> ✅", async () => {
  const reactions = [];
  const sentMessages = [];

  const mockSock = {
    sendMessage: async (jid, payload) => {
      if (payload.react) reactions.push(payload.react.text);
      if (payload.image || payload.document) sentMessages.push(payload);
    }
  };

  const sampleImg = fs.readFileSync("/tmp/test_in.jpg");
  const { Readable } = require("stream");

  const mockMsg = {
    key: { remoteJid: "1234567890@s.whatsapp.net" },
    message: {
      extendedTextMessage: {
        text: "hd",
        contextInfo: {
          quotedMessage: {
            imageMessage: { mimetype: "image/jpeg" }
          }
        }
      }
    }
  };

  // Provide mock downloader
  globalThis.downloadContentFromMessage = async () => Readable.from([sampleImg]);

  await me.executeMediaEnhance(mockSock, mockMsg, [], "hd");

  assert.equal(reactions[0], "🌀", "Expected initial 🌀 reaction");
  assert.equal(reactions[1], "✅", "Expected success ✅ reaction");
  assert.equal(sentMessages.length, 1, "Expected enhanced image to be sent");
  assert.ok(sentMessages[0].caption.includes("HD Enhanced"), "Expected HD caption");
});

test("executeMediaEnhance 4K processes image with 🌀 -> ✅", async () => {
  const reactions = [];
  const sentMessages = [];

  const mockSock = {
    sendMessage: async (jid, payload) => {
      if (payload.react) reactions.push(payload.react.text);
      if (payload.image || payload.document) sentMessages.push(payload);
    }
  };

  const sampleImg = fs.readFileSync("/tmp/test_in.jpg");
  const { Readable } = require("stream");

  const mockMsg = {
    key: { remoteJid: "1234567890@s.whatsapp.net" },
    message: {
      extendedTextMessage: {
        text: "4k",
        contextInfo: {
          quotedMessage: {
            imageMessage: { mimetype: "image/jpeg" }
          }
        }
      }
    }
  };

  globalThis.downloadContentFromMessage = async () => Readable.from([sampleImg]);

  await me.executeMediaEnhance(mockSock, mockMsg, [], "4k");

  assert.equal(reactions[0], "🌀", "Expected initial 🌀 reaction");
  assert.equal(reactions[1], "✅", "Expected success ✅ reaction");
  assert.equal(sentMessages.length, 1, "Expected 4K enhanced image to be sent");
  assert.ok(sentMessages[0].caption.includes("4K Ultra HD Enhanced"), "Expected 4K caption");
});

test("executeMediaEnhance HD processes video with 1.3 pipeline and reacts 🌀 -> ✅", async () => {
  const reactions = [];
  const sentVideos = [];

  const mockSock = {
    sendMessage: async (jid, payload) => {
      if (payload.react) reactions.push(payload.react.text);
      if (payload.video || payload.document) sentVideos.push(payload);
      return { key: { id: 'mock_sent_id' } };
    }
  };

  const sampleVid = fs.readFileSync("/tmp/sample.mp4");
  const { Readable } = require("stream");

  const mockMsg = {
    key: { remoteJid: "1234567890@s.whatsapp.net" },
    message: {
      extendedTextMessage: {
        text: "hd",
        contextInfo: {
          quotedMessage: {
            videoMessage: { mimetype: "video/mp4" }
          }
        }
      }
    }
  };

  globalThis.downloadContentFromMessage = async () => Readable.from([sampleVid]);

  await me.executeMediaEnhance(mockSock, mockMsg, [], "hd");

  assert.equal(reactions[0], "🌀", "Expected initial 🌀 reaction");
  assert.equal(reactions[1], "✅", "Expected success ✅ reaction");
  assert.equal(sentVideos.length, 1, "Expected HD video to be sent");
  assert.ok(sentVideos[0].caption.includes("HD 1080p Video"), "Expected HD caption");
});

test("executeMediaEnhance 4K processes video with 4K pipeline and reacts 🌀 -> ✅", async () => {
  const reactions = [];
  const sentVideos = [];

  const mockSock = {
    sendMessage: async (jid, payload) => {
      if (payload.react) reactions.push(payload.react.text);
      if (payload.video || payload.document) sentVideos.push(payload);
      return { key: { id: 'mock_sent_id' } };
    }
  };

  const sampleVid = fs.readFileSync("/tmp/sample.mp4");
  const { Readable } = require("stream");

  const mockMsg = {
    key: { remoteJid: "1234567890@s.whatsapp.net" },
    message: {
      extendedTextMessage: {
        text: "4k",
        contextInfo: {
          quotedMessage: {
            videoMessage: { mimetype: "video/mp4" }
          }
        }
      }
    }
  };

  globalThis.downloadContentFromMessage = async () => Readable.from([sampleVid]);

  await me.executeMediaEnhance(mockSock, mockMsg, [], "4k");

  assert.equal(reactions[0], "🌀", "Expected initial 🌀 reaction");
  assert.equal(reactions[1], "✅", "Expected success ✅ reaction");
  assert.equal(sentVideos.length, 1, "Expected 4K video to be sent");
  assert.ok(sentVideos[0].caption.includes("4K Ultra HD Video"), "Expected 4K caption");
});
