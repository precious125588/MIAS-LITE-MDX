// ESM wrapper around lib/pin-helper.cjs
import { createRequire } from 'module';
import { fileURLToPath } from 'url';
import path from 'path';

const require = createRequire(import.meta.url);
const here = path.dirname(fileURLToPath(import.meta.url));
const helper = require(path.join(here, 'pin-helper.cjs'));

export const unwrapMessage = helper.unwrapMessage;
export const extractContextInfo = helper.extractContextInfo;
export const extractQuotedContext = helper.extractQuotedContext;
export const parsePinDuration = helper.parsePinDuration;
export const getPinDurationLabel = helper.getPinDurationLabel;
export const normalizeJid = helper.normalizeJid;
export const cleanDigits = helper.cleanDigits;
export const buildPinKey = helper.buildPinKey;

export default helper;
