import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import vm from "node:vm";

const HERE = dirname(fileURLToPath(import.meta.url));
const SOURCE = readFileSync(join(HERE, "..", "addon", "lib", "doi-http.js"), "utf8");

class UnexpectedStatusException extends Error {
  constructor(status, retryAfter) {
    super(`HTTP ${status}`);
    this.xmlhttp = {
      status,
      getResponseHeader: (name) => (name === "Retry-After" ? retryAfter : null),
    };
  }
}

function loadDoiHttp(request) {
  const sandbox = {
    Zotero: { HTTP: { request, UnexpectedStatusException } },
    setTimeout: (callback) => {
      callback();
      return 0;
    },
  };
  vm.createContext(sandbox);
  vm.runInContext(SOURCE, sandbox);
  return sandbox.DoiHttp;
}

test("retries transient HTTP failures before returning a successful DOI response", async () => {
  let attempts = 0;
  const doiHttp = loadDoiHttp(async () => {
    attempts += 1;
    if (attempts < 3) throw new UnexpectedStatusException(503);
    return { response: { handle: "10.1000/example" } };
  });

  const result = await doiHttp.fetchDoiHandle("https://doi.org/api/handles/10.1000%2Fexample");

  assert.equal(attempts, 3);
  assert.equal(result.status, "ok");
  assert.equal(result.response.handle, "10.1000/example");
});

test("does not retry DOI responses that establish an invalid identifier", async () => {
  let attempts = 0;
  const doiHttp = loadDoiHttp(async () => {
    attempts += 1;
    throw new UnexpectedStatusException(404);
  });

  const result = await doiHttp.fetchDoiHandle("https://doi.org/api/handles/missing");

  assert.equal(attempts, 1);
  assert.equal(result.status, "invalid");
});

test("reuses successful responses from the bounded session cache", async () => {
  let attempts = 0;
  const doiHttp = loadDoiHttp(async () => {
    attempts += 1;
    return { response: { handle: "10.1000/example" } };
  });

  await doiHttp.fetchDoiHandle("https://doi.org/api/handles/10.1000%2Fexample");
  await doiHttp.fetchDoiHandle("https://doi.org/api/handles/10.1000%2Fexample");

  assert.equal(attempts, 1);
});

test("reduces the recommended concurrency after a rate limit response", async () => {
  const doiHttp = loadDoiHttp(async () => {
    throw new UnexpectedStatusException(429);
  });

  await doiHttp.fetchDoiHandle("https://doi.org/api/handles/rate-limited");

  assert.equal(doiHttp.getRecommendedConcurrency(), 1);
});
