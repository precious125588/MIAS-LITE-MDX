"use strict";

const axios = require("axios");
const axiosRetryModule = require("axios-retry");
const axiosRetry = axiosRetryModule.default || axiosRetryModule;

const DEFAULT_TIMEOUT_MS = 20_000;
const DEFAULT_MAX_BYTES = 50 * 1024 * 1024;
const RETRYABLE_METHODS = new Set(["GET", "HEAD", "OPTIONS"]);

function assertHttpUrl(input) {
  const url = input instanceof URL ? input : new URL(String(input));
  if (!["http:", "https:"].includes(url.protocol)) {
    throw new TypeError(`Unsupported URL protocol: ${url.protocol}`);
  }
  return url;
}

function parsePositiveInt(value, fallback, max) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed <= 0) return fallback;
  return Math.min(Math.floor(parsed), max);
}

function createHttpClient(options = {}) {
  const timeout = parsePositiveInt(
    options.timeout ?? process.env.MIAS_HTTP_TIMEOUT_MS,
    DEFAULT_TIMEOUT_MS,
    120_000,
  );
  const maxContentLength = parsePositiveInt(
    options.maxContentLength ?? process.env.MIAS_HTTP_MAX_BYTES,
    DEFAULT_MAX_BYTES,
    200 * 1024 * 1024,
  );
  const retryCount = parsePositiveInt(
    options.retries ?? process.env.MIAS_HTTP_RETRIES,
    2,
    5,
  );

  const client = axios.create({
    timeout,
    maxContentLength,
    maxBodyLength: maxContentLength,
    transitional: { clarifyTimeoutError: true },
    headers: {
      "User-Agent": options.userAgent || "MIAS/5 (+https://github.com/precious125588/fantastic-waddle)",
      Accept: options.accept || "*/*",
    },
  });

  axiosRetry(client, {
    retries: retryCount,
    retryDelay: axiosRetryModule.exponentialDelay,
    retryCondition: (error) => {
      const method = String(error.config?.method || "get").toUpperCase();
      if (!RETRYABLE_METHODS.has(method) && options.retryUnsafeMethods !== true) return false;
      return axiosRetryModule.isNetworkOrIdempotentRequestError(error) ||
        Boolean(error.response && error.response.status >= 429);
    },
    shouldResetTimeout: true,
  });

  client.interceptors.request.use((config) => {
    assertHttpUrl(config.url);
    return config;
  });

  return client;
}

const defaultClient = createHttpClient();

async function fetchBuffer(url, options = {}) {
  assertHttpUrl(url);
  const response = await (options.client || defaultClient).get(String(url), {
    ...options,
    client: undefined,
    responseType: "arraybuffer",
    maxContentLength: options.maxBytes || DEFAULT_MAX_BYTES,
    maxBodyLength: options.maxBytes || DEFAULT_MAX_BYTES,
  });
  return Buffer.isBuffer(response.data) ? response.data : Buffer.from(response.data);
}

async function getJson(url, options = {}) {
  assertHttpUrl(url);
  const { client, ...requestOptions } = options;
  const response = await (client || defaultClient).get(String(url), requestOptions);
  return response.data;
}

async function postJson(url, body, options = {}) {
  assertHttpUrl(url);
  const { client, ...requestOptions } = options;
  const response = await (client || defaultClient).post(String(url), body, requestOptions);
  return response.data;
}

module.exports = {
  DEFAULT_MAX_BYTES,
  DEFAULT_TIMEOUT_MS,
  assertHttpUrl,
  axios: defaultClient,
  client: defaultClient,
  createHttpClient,
  defaultClient,
  fetchBuffer,
  getJson,
  postJson,
};