'use strict';

const WRAPPER_KEYS = [
  'deviceSentMessage',
  'ephemeralMessage',
  'viewOnceMessage',
  'viewOnceMessageV2',
  'viewOnceMessageV2Extension',
  'documentWithCaptionMessage',
  'editedMessage',
];

const MEDIA_TYPES = {
  imageMessage: { type: 'image', downloadType: 'image' },
  videoMessage: { type: 'video', downloadType: 'video' },
  audioMessage: { type: 'audio', downloadType: 'audio' },
  documentMessage: { type: 'document', downloadType: 'document' },
  stickerMessage: { type: 'sticker', downloadType: 'sticker' },
  ptvMessage: { type: 'video', downloadType: 'video' },
};

function unwrapMessage(message = {}) {
  let current = message;
  for (let depth = 0; depth < 12; depth += 1) {
    if (!current || typeof current !== 'object') return {};
    let next = null;
    for (const key of WRAPPER_KEYS) {
      if (current[key]?.message && typeof current[key].message === 'object') {
        next = current[key].message;
        break;
      }
    }
    if (!next || next === current) break;
    current = next;
  }
  return current || {};
}

function getRootMessage(value) {
  return value?.message && typeof value.message === 'object' ? value.message : value;
}

function getContextInfo(value) {
  let current = getRootMessage(value);
  const contexts = [];

  for (let depth = 0; depth < 12 && current && typeof current === 'object'; depth += 1) {
    if (current.contextInfo && typeof current.contextInfo === 'object') {
      contexts.push(current.contextInfo);
    }

    for (const [key, node] of Object.entries(current)) {
      if (WRAPPER_KEYS.includes(key) || !node || typeof node !== 'object') continue;
      if (node.contextInfo && typeof node.contextInfo === 'object') {
        contexts.push(node.contextInfo);
      }
    }

    const next = WRAPPER_KEYS
      .map((key) => current[key]?.message)
      .find((message) => message && typeof message === 'object');
    if (!next || next === current) break;
    current = next;
  }

  return contexts.find((context) => context.quotedMessage) || contexts[0] || null;
}

function getQuotedMessage(value) {
  return getContextInfo(value)?.quotedMessage || value?.quoted?.message || value?.quoted?.msg || null;
}

function attachCanonicalQuoteContext(value, context = getContextInfo(value)) {
  if (!value?.message || !context?.quotedMessage) return value;

  const message = value.message;
  const extended = message.extendedTextMessage || {};
  const existingContext = extended.contextInfo || {};
  if (existingContext.quotedMessage) return value;

  value.message = {
    ...message,
    extendedTextMessage: {
      ...extended,
      contextInfo: {
        ...context,
        ...existingContext,
        quotedMessage: existingContext.quotedMessage || context.quotedMessage,
      },
    },
  };
  return value;
}

function isImageDocument(content = {}) {
  const mime = String(content.mimetype || '').split(';', 1)[0].toLowerCase();
  if (mime.startsWith('image/')) return true;
  return /\.(?:avif|gif|jpe?g|png|webp|bmp|tiff?)$/i.test(String(content.fileName || ''));
}

function findMediaNode(value) {
  const message = unwrapMessage(getRootMessage(value));
  for (const [messageType, types] of Object.entries(MEDIA_TYPES)) {
    const content = message?.[messageType];
    if (!content || typeof content !== 'object') continue;
    const type = messageType === 'documentMessage' && isImageDocument(content)
      ? 'image'
      : types.type;
    return {
      content,
      type,
      messageType,
      downloadType: types.downloadType,
      mimetype: content.mimetype || '',
      fileName: content.fileName || '',
    };
  }
  return null;
}

function extractTextFromMessage(value) {
  const message = unwrapMessage(getRootMessage(value));
  return String(
    message.conversation
      || message.extendedTextMessage?.text
      || message.extendedTextMessage?.matchedText
      || message.imageMessage?.caption
      || message.videoMessage?.caption
      || message.documentMessage?.caption
      || message.audioMessage?.caption
      || message.buttonsResponseMessage?.selectedButtonId
      || message.listResponseMessage?.singleSelectReply?.selectedRowId
      || message.templateButtonReplyMessage?.selectedId
      || message.interactiveResponseMessage?.nativeFlowResponseMessage?.paramsJson
      || message.pollCreationMessage?.name
      || '',
  );
}

module.exports = {
  WRAPPER_KEYS,
  unwrapMessage,
  getContextInfo,
  getQuotedMessage,
  attachCanonicalQuoteContext,
  findMediaNode,
  isImageDocument,
  extractTextFromMessage,
};
