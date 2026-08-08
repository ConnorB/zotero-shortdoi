/**
 * HTTP fetchers for DOI resolution APIs.
 *
 * Wraps Zotero.HTTP.request and normalizes results so the update loop
 * never has to think about XHR status codes or exception types.
 */

const REQUEST_TIMEOUT_MS = 30_000;
const MAX_ATTEMPTS = 3;
const INITIAL_RETRY_DELAY_MS = 500;
const RESPONSE_CACHE_TTL_MS = 10 * 60 * 1_000;
const MAX_CACHED_RESPONSES = 500;
const DEFAULT_CONCURRENCY = 3;
const MAX_CONCURRENCY = 6;

const responseCache = new Map();
let recommendedConcurrency = DEFAULT_CONCURRENCY;
let successfulRequestsSinceAdjustment = 0;

function getStatusCode(error) {
  return error?.xmlhttp?.status ?? 0;
}

function getRetryDelay(error, attempt) {
  const retryAfter = Number(error?.xmlhttp?.getResponseHeader?.("Retry-After"));
  if (Number.isFinite(retryAfter) && retryAfter > 0) {
    return retryAfter * 1_000;
  }
  return INITIAL_RETRY_DELAY_MS * 2 ** (attempt - 1);
}

function shouldRetry(error) {
  const status = getStatusCode(error);
  return status === 0 || status === 429 || (status >= 500 && status < 600);
}

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function cacheKey(url, responseType) {
  return `${responseType}:${url}`;
}

function getCachedResponse(url, responseType) {
  const key = cacheKey(url, responseType);
  const cached = responseCache.get(key);
  if (!cached) return null;
  if (cached.expiresAt <= Date.now()) {
    responseCache.delete(key);
    return null;
  }
  // Refresh recency so pruning removes the least recently used entry.
  responseCache.delete(key);
  responseCache.set(key, cached);
  return cached.result;
}

function cacheResponse(url, responseType, result) {
  if (result.status !== "ok" && result.status !== "invalid") return;
  const key = cacheKey(url, responseType);
  responseCache.set(key, { result, expiresAt: Date.now() + RESPONSE_CACHE_TTL_MS });
  while (responseCache.size > MAX_CACHED_RESPONSES) {
    responseCache.delete(responseCache.keys().next().value);
  }
}

function noteRequestSuccess() {
  successfulRequestsSinceAdjustment += 1;
  if (successfulRequestsSinceAdjustment >= 20 && recommendedConcurrency < MAX_CONCURRENCY) {
    recommendedConcurrency += 1;
    successfulRequestsSinceAdjustment = 0;
  }
}

function noteRateLimit() {
  recommendedConcurrency = Math.max(1, Math.floor(recommendedConcurrency / 2));
  successfulRequestsSinceAdjustment = 0;
}

function getRecommendedConcurrency() {
  return recommendedConcurrency;
}

/**
 * Issue an HTTP GET via Zotero.HTTP.request and return either the response
 * object or a status describing the failure mode.
 *
 * 400 and 404 are returned as `{ status: "invalid" }` because every API this
 * plugin talks to (shortdoi.org, doi.org, CrossRef) treats those as "not a
 * valid identifier" rather than a transport error.
 *
 * @param {string} url
 * @param {"json" | "document"} responseType
 * @returns {Promise<{status: "ok", response: any}
 *               | {status: "invalid"}
 *               | {status: "error", error: Error}>}
 */
async function fetchJsonOrDoc(url, responseType) {
  const cached = getCachedResponse(url, responseType);
  if (cached) return cached;

  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    try {
      const xhr = await Zotero.HTTP.request("GET", url, {
        responseType,
        timeout: REQUEST_TIMEOUT_MS,
        successCodes: [200],
      });
      const response = responseType === "json" ? xhr.response : xhr.responseXML;
      const result = { status: "ok", response };
      noteRequestSuccess();
      cacheResponse(url, responseType, result);
      return result;
    } catch (error) {
      if (error instanceof Zotero.HTTP.UnexpectedStatusException) {
        const code = getStatusCode(error);
        if (code === 400 || code === 404) {
          const result = { status: "invalid" };
          cacheResponse(url, responseType, result);
          return result;
        }
        if (code === 429) noteRateLimit();
      }
      if (attempt < MAX_ATTEMPTS && shouldRetry(error)) {
        await delay(getRetryDelay(error, attempt));
        continue;
      }
      return { status: "error", error };
    }
  }
}

/**
 * Look up a DOI handle (long form lookup or shortDOI lookup).
 *
 * @param {string} url
 * @returns {Promise<{status: "ok", response: object}
 *               | {status: "invalid"}
 *               | {status: "error", error: Error}>}
 */
function fetchDoiHandle(url) {
  return fetchJsonOrDoc(url, "json");
}

/**
 * Look up an item by metadata via the CrossRef OpenURL endpoint.
 *
 * @param {string} url
 * @returns {Promise<{status: "ok", response: Document}
 *               | {status: "invalid"}
 *               | {status: "error", error: Error}>}
 */
function fetchCrossref(url) {
  return fetchJsonOrDoc(url, "document");
}

var DoiHttp = Object.freeze({
  fetchDoiHandle,
  fetchCrossref,
  getRecommendedConcurrency,
});
