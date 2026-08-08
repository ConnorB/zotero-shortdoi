import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import vm from "node:vm";

const HERE = dirname(fileURLToPath(import.meta.url));
const SOURCE = readFileSync(join(HERE, "..", "addon", "lib", "doi-updater.js"), "utf8");

function makeItem(id, doi = "10.1000/example") {
  const fields = { DOI: doi };
  const tags = new Set();
  const attachments = [];
  let saveCount = 0;
  return {
    id,
    itemTypeID: 1,
    isRegularItem: () => true,
    getField: (field) => fields[field] ?? "",
    setField: (field, value) => {
      fields[field] = value;
    },
    hasTag: (tag) => tags.has(tag),
    addTag: (tag) => tags.add(tag),
    removeTag: (tag) => tags.delete(tag),
    getAttachments: () => attachments,
    save: async () => {
      saveCount += 1;
    },
    saveTx: async () => {},
    get saveCount() {
      return saveCount;
    },
  };
}

function loadUpdater({ fetchDoiHandle, fetchCrossref = async () => ({ status: "invalid" }) }) {
  const windows = [];
  const attachments = new Map();
  let nextAttachmentID = 1;
  let transactionCount = 0;

  class ProgressWindow {
    constructor() {
      this.ItemProgress = class {
        setProgress() {}
        setText() {}
        setError() {}
      };
    }
    changeHeadline(headline) {
      this.headline = headline;
      windows.push(this);
    }
    show() {}
    close() {}
    startCloseTimer() {}
  }

  const sandbox = {
    DoiHttp: { fetchDoiHandle, fetchCrossref },
    DoiService: {
      SUPPORTED_ITEM_TYPES: ["journalArticle"],
      buildDoiLookupUrl: (doi) => ({ kind: "lookup", url: `doi:${doi}` }),
      buildCrossrefUrl: (context) => `crossref:${context}`,
      buildCrossrefLinkUrl: (context) => `link:${context}`,
      isShortDoi: () => false,
      parseLongDoiResponse: (response) => ({ ok: true, doi: response.handle }),
      parseShortDoiResponse: (response) => response.handle,
      parseCheckDoiResponse: (response, doi) =>
        response.handle === doi ? { kind: "unchanged" } : { kind: "updated", doi: response.handle },
      parseCrossrefResponse: (response) => response,
    },
    Zotero: {
      hiDPI: false,
      debug: () => {},
      Prefs: { get: () => "" },
      ItemTypes: { getID: () => 1, getName: () => "journalArticle" },
      DB: {
        executeTransaction: async (callback) => {
          transactionCount += 1;
          return callback();
        },
      },
      ProgressWindow,
      OpenURL: { createContextObject: (item) => `item=${item.id}` },
      Items: { get: (id) => attachments.get(id) },
      Attachments: {
        linkFromURL: async ({ url, parentItemID }) => {
          const id = nextAttachmentID++;
          attachments.set(id, { getField: (field) => (field === "url" ? url : "") });
          const item = sandbox.items.get(parentItemID);
          item.getAttachments().push(id);
        },
      },
    },
    items: new Map(),
  };
  vm.createContext(sandbox);
  vm.runInContext(SOURCE, sandbox);
  return {
    updater: sandbox.DoiUpdater,
    windows,
    items: sandbox.items,
    attachments,
    get transactionCount() {
      return transactionCount;
    },
  };
}

test("deduplicates matching DOI requests within one batch", async () => {
  let calls = 0;
  const fixture = loadUpdater({
    fetchDoiHandle: async () => {
      calls += 1;
      return { status: "ok", response: { handle: "10.1000/example" } };
    },
  });
  const first = makeItem(1);
  const second = makeItem(2);
  fixture.items.set(first.id, first);
  fixture.items.set(second.id, second);

  await fixture.updater.updateItems([first, second], "long", "resource://plugin/");

  assert.equal(calls, 1);
});

test("queues a later update instead of dropping it while a batch is running", async () => {
  let calls = 0;
  let beginFirstRequest;
  const firstRequestStarted = new Promise((resolve) => {
    beginFirstRequest = resolve;
  });
  let releaseFirstRequest;
  const firstRequestReleased = new Promise((resolve) => {
    releaseFirstRequest = resolve;
  });
  const fixture = loadUpdater({
    fetchDoiHandle: async () => {
      calls += 1;
      if (calls === 1) {
        beginFirstRequest();
        await firstRequestReleased;
      }
      return { status: "ok", response: { handle: "10.1000/example" } };
    },
  });
  const first = makeItem(1);
  const second = makeItem(2, "10.1000/second");
  fixture.items.set(first.id, first);
  fixture.items.set(second.id, second);

  const firstRun = fixture.updater.updateItems([first], "long", "resource://plugin/");
  await firstRequestStarted;
  const queuedRun = fixture.updater.updateItems([second], "long", "resource://plugin/");
  releaseFirstRequest();
  await Promise.all([firstRun, queuedRun]);

  assert.equal(calls, 2);
});

test("reports failed requests instead of showing a successful completion", async () => {
  const fixture = loadUpdater({
    fetchDoiHandle: async () => ({ status: "error", error: new Error("offline") }),
  });
  const item = makeItem(1);
  fixture.items.set(item.id, item);

  await fixture.updater.updateItems([item], "long", "resource://plugin/");

  assert.ok(fixture.windows.some((window) => window.headline === "DOI lookup failed"));
  assert.ok(!fixture.windows.some((window) => window.headline === "Finished"));
});

test("does not add a second attachment for the same multiple-DOI result", async () => {
  const fixture = loadUpdater({
    fetchDoiHandle: async () => ({ status: "invalid" }),
    fetchCrossref: async () => ({ status: "ok", response: { status: "multiresolved" } }),
  });
  const item = makeItem(1, "");
  fixture.items.set(item.id, item);

  await fixture.updater.updateItems([item], "long", "resource://plugin/");
  await fixture.updater.updateItems([item], "long", "resource://plugin/");

  assert.equal(fixture.attachments.size, 1);
});

test("commits all changed items in one transaction after lookup work completes", async () => {
  const fixture = loadUpdater({
    fetchDoiHandle: async (url) => ({
      status: "ok",
      response: { handle: `${url.replace("doi:", "")}/resolved` },
    }),
  });
  const first = makeItem(1, "10.1000/first");
  const second = makeItem(2, "10.1000/second");
  fixture.items.set(first.id, first);
  fixture.items.set(second.id, second);

  await fixture.updater.updateItems([first, second], "long", "resource://plugin/");

  assert.equal(fixture.transactionCount, 1);
  assert.equal(first.saveCount, 1);
  assert.equal(second.saveCount, 1);
});
