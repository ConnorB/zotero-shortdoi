/**
 * Async update loop. Replaces the previous callback-based state machine.
 *
 * `updateItems(items, operation)` is the only entry point. Calls arriving
 * while a batch is active are coalesced into a subsequent batch, so automatic
 * retrieval and manual commands never lose work.
 */

const ICONS = Object.freeze({
  ERROR: "chrome://zotero/skin/cross.png",
  SUCCESS: "chrome://zotero/skin/tick.png",
});

const PROGRESS_HEADLINES = Object.freeze({
  short: "Getting shortDOIs",
  long: "Getting long DOIs",
  check: "Validating DOIs and removing extra text",
});

const COMPLETION_MESSAGES = Object.freeze({
  short: (n) => `shortDOIs updated for ${n} items.`,
  long: (n) => `Long DOIs updated for ${n} items.`,
  check: (n) => `DOIs verified for ${n} items.`,
});

// A small pool is considerably faster than a serial batch without flooding
// doi.org, shortdoi.org, or Crossref (or making progress UI noisy).
const MAX_CONCURRENT_REQUESTS = 3;
const MAX_CONFIGURED_CONCURRENCY = 6;
const PROGRESS_UPDATE_INTERVAL_MS = 100;

const ERROR_MESSAGES = Object.freeze({
  invalid: {
    headline: "Invalid DOI",
    plain: "Invalid DOIs were found.",
    tagged: (tag) => `Invalid DOIs were found. These have been tagged with '${tag}'.`,
  },
  nodoi: {
    headline: "DOI not found",
    plain: "No DOI was found for some items.",
    tagged: (tag) => `No DOI was found for some items. These have been tagged with '${tag}'.`,
  },
  multiple: {
    headline: "Multiple possible DOIs",
    plain: "Some items had multiple possible DOIs.",
    tagged: (tag) =>
      `Some items had multiple possible DOIs. Links to lists of DOIs have been added and tagged with '${tag}'.`,
  },
  failed: {
    headline: "DOI lookup failed",
    plain: (n) => `${n} DOI lookup(s) failed because of a network or server problem. Try again.`,
  },
});

let isRunning = false;
const pendingBatches = [];
let supportedTypeIDs;

/**
 * Read all DOI-related preferences once per run.
 *
 * @returns {{tagInvalid: string, tagNodoi: string, tagMultiple: string, autoretrieve: string}}
 */
function readPrefs() {
  const get = (key) => Zotero.Prefs.get(`extensions.shortdoi.${key}`, true);
  return {
    tagInvalid: get("tag_invalid"),
    tagNodoi: get("tag_nodoi"),
    tagMultiple: get("tag_multiple"),
    autoretrieve: get("autoretrieve"),
    maxConcurrentRequests: get("max_concurrent_requests"),
  };
}

function removeAllDoiTags(item, prefs) {
  let changed = false;
  for (const tag of [prefs.tagInvalid, prefs.tagMultiple, prefs.tagNodoi]) {
    if (tag && item.hasTag(tag)) {
      item.removeTag(tag);
      changed = true;
    }
  }
  return changed;
}

function hasAnyDoiTag(item, prefs) {
  return (
    item.hasTag(prefs.tagInvalid) ||
    item.hasTag(prefs.tagMultiple) ||
    item.hasTag(prefs.tagNodoi)
  );
}

/**
 * Filter the input set to items whose type the plugin supports.
 *
 * @returns {{ supported: Zotero.Item[], unsupported: Zotero.Item[] }}
 */
function partitionItems(items) {
  supportedTypeIDs ??= new Set(
    DoiService.SUPPORTED_ITEM_TYPES
      .map((type) => Zotero.ItemTypes.getID(type))
      .filter((id) => id !== false)
  );

  const supported = [];
  const unsupported = [];

  for (const item of items) {
    if (!item.isRegularItem() || item.isFeedItem) continue;
    if (supportedTypeIDs.has(item.itemTypeID)) {
      supported.push(item);
    } else {
      unsupported.push(item);
    }
  }

  return { supported, unsupported };
}

function showUnsupportedWarning(unsupportedItems) {
  const types = [
    ...new Set(
      unsupportedItems.map((item) => Zotero.ItemTypes.getName(item.itemTypeID))
    ),
  ];

  const window = new Zotero.ProgressWindow({ closeOnClick: true });
  window.changeHeadline("Unsupported Item Types");
  window.progress = new window.ItemProgress(
    ICONS.ERROR,
    `${unsupportedItems.length} item(s) skipped (unsupported types: ${types.join(", ")})`
  );
  window.progress.setError();
  window.show();
  window.startCloseTimer(6000);
}

function openProgressWindow(operation, rootURI) {
  const window = new Zotero.ProgressWindow({ closeOnClick: true });
  const headlineIcon = `chrome://zotero/skin/toolbar-advanced-search${Zotero.hiDPI ? "@2x" : ""}.png`;
  window.changeHeadline(PROGRESS_HEADLINES[operation] ?? PROGRESS_HEADLINES.check, headlineIcon);

  const doiIcon = `${rootURI}skin/doi${Zotero.hiDPI ? "@2x" : ""}.png`;
  window.progress = new window.ItemProgress(doiIcon, "Checking DOIs.");
  window.show();
  return window;
}

function updateProgress(window, current, total) {
  const percent = Math.round((current / total) * 100);
  window.progress.setProgress(percent);
  window.progress.setText(`Item ${current} of ${total}`);
}

function createProgressUpdater(window, total) {
  let lastUpdate = 0;
  return (current) => {
    const now = Date.now();
    if (current === total || now - lastUpdate >= PROGRESS_UPDATE_INTERVAL_MS) {
      updateProgress(window, current, total);
      lastUpdate = now;
    }
  };
}

function showCompletion(progressWindow, operation, results, prefs) {
  const errorBuckets = ["invalid", "nodoi", "multiple", "failed"];
  const hasErrors = errorBuckets.some((bucket) => results.counts[bucket] > 0);

  if (progressWindow) progressWindow.close();

  if (hasErrors) {
    showErrorWindows(results.counts, prefs);
    return;
  }

  const successWindow = new Zotero.ProgressWindow({ closeOnClick: true });
  successWindow.changeHeadline("Finished");
  successWindow.progress = new successWindow.ItemProgress(ICONS.SUCCESS, "");
  successWindow.progress.setProgress(100);
  const message = (COMPLETION_MESSAGES[operation] ?? COMPLETION_MESSAGES.check)(results.counts.updated);
  successWindow.progress.setText(message);
  successWindow.show();
  successWindow.startCloseTimer(4000);
}

function showErrorWindows(counts, prefs) {
  const tagFor = { invalid: prefs.tagInvalid, nodoi: prefs.tagNodoi, multiple: prefs.tagMultiple };

  for (const bucket of ["invalid", "nodoi", "multiple", "failed"]) {
    if (counts[bucket] === 0) continue;

    const config = ERROR_MESSAGES[bucket];
    const tag = tagFor[bucket];
    const message =
      bucket === "failed"
        ? config.plain(counts[bucket])
        : tag
          ? config.tagged(tag)
          : config.plain;

    const window = new Zotero.ProgressWindow({ closeOnClick: true });
    window.changeHeadline(config.headline);
    window.progress = new window.ItemProgress(ICONS.ERROR, message);
    window.progress.setError();
    window.show();
    window.startCloseTimer(8000);
  }
}

/**
 * Mark an item as having an invalid DOI, and tag it if the preference is set.
 */
async function markInvalid(item, prefs, saver) {
  if (!item.isRegularItem()) return;
  let changed = false;
  for (const tag of [prefs.tagMultiple, prefs.tagNodoi]) {
    if (tag && item.hasTag(tag)) {
      item.removeTag(tag);
      changed = true;
    }
  }
  if (prefs.tagInvalid && !item.hasTag(prefs.tagInvalid)) {
    item.addTag(prefs.tagInvalid, 1);
    changed = true;
  }
  if (changed) saver.mark(item);
}

/**
 * Process a single item for a single operation.
 *
 * @returns {Promise<"updated" | "invalid" | "nodoi" | "multiple" | "failed" | "skipped">}
 */
async function processItem(item, operation, prefs, requestCache, saver) {
  const existingDoi = item.getField("DOI");

  if (!existingDoi) {
    return processCrossrefLookup(item, operation, prefs, requestCache, saver);
  }

  const target = DoiService.buildDoiLookupUrl(existingDoi, operation);
  if (target?.kind === "invalid") {
    await markInvalid(item, prefs, saver);
    return "invalid";
  }
  if (!target) {
    if (item.hasTag(prefs.tagInvalid)) {
      item.removeTag(prefs.tagInvalid);
      saver.mark(item);
    }
    return "skipped";
  }

  const result = await requestCache.fetchDoiHandle(target.url);

  if (result.status === "invalid") {
    await markInvalid(item, prefs, saver);
    return "invalid";
  }

  if (result.status === "error") {
    Zotero.debug(`DOI Manager: HTTP error fetching DOI: ${result.error}`);
    return "failed";
  }

  return applyDoiResponse(result.response, item, existingDoi, operation, prefs, saver);
}

async function applyDoiResponse(response, item, existingDoi, operation, prefs, saver) {
  if (!item.isRegularItem()) return "skipped";

  switch (operation) {
    case "short": {
      const shortDoi = DoiService.parseShortDoiResponse(response);
      if (!shortDoi) {
        await markInvalid(item, prefs, saver);
        return "invalid";
      }
      const changed = shortDoi !== existingDoi;
      if (changed) item.setField("DOI", shortDoi);
      if (removeAllDoiTags(item, prefs) || changed) saver.mark(item);
      return "updated";
    }

    case "long": {
      const parsed = DoiService.parseLongDoiResponse(
        response,
        DoiService.isShortDoi(existingDoi)
      );
      if (!parsed.ok) {
        await markInvalid(item, prefs, saver);
        return "invalid";
      }
      const changed = parsed.doi !== existingDoi;
      if (changed) item.setField("DOI", parsed.doi);
      if (removeAllDoiTags(item, prefs) || changed) saver.mark(item);
      return "updated";
    }

    case "check":
    default: {
      const parsed = DoiService.parseCheckDoiResponse(response, existingDoi);
      if (parsed.kind === "invalid") {
        await markInvalid(item, prefs, saver);
        return "invalid";
      }
      if (parsed.kind === "updated") {
        item.setField("DOI", parsed.doi);
        removeAllDoiTags(item, prefs);
        saver.mark(item);
      } else if (hasAnyDoiTag(item, prefs)) {
        removeAllDoiTags(item, prefs);
        saver.mark(item);
      }
      return "updated";
    }
  }
}

/**
 * Item has no DOI: try CrossRef. On a single resolved hit, apply the DOI
 * (and recurse for the "short" operation to convert it to shortDOI form).
 */
async function processCrossrefLookup(item, operation, prefs, requestCache, saver) {
  const ctx = Zotero.OpenURL.createContextObject(item, "1.0");
  if (!ctx) return "skipped";

  const result = await requestCache.fetchCrossref(DoiService.buildCrossrefUrl(ctx));

  if (result.status === "error") {
    Zotero.debug(`DOI Manager: CrossRef lookup failed: ${result.error}`);
    return "failed";
  }
  if (result.status === "invalid") {
    return "skipped";
  }

  const parsed = DoiService.parseCrossrefResponse(result.response);

  switch (parsed.status) {
    case "resolved": {
      item.setField("DOI", parsed.doi);
      if (operation === "short") {
        return processItem(item, operation, prefs, requestCache, saver);
      }
      removeAllDoiTags(item, prefs);
      saver.mark(item);
      return "updated";
    }

    case "unresolved": {
      let changed = removeAllDoiTags(item, prefs);
      if (prefs.tagNodoi && !item.hasTag(prefs.tagNodoi)) {
        item.addTag(prefs.tagNodoi, 1);
        changed = true;
      }
      if (changed) saver.mark(item);
      return "nodoi";
    }

    case "multiresolved": {
      const linkUrl = DoiService.buildCrossrefLinkUrl(ctx);
      await ensureMultipleDoiAttachment(item, linkUrl);
      let changed = false;
      for (const tag of [prefs.tagInvalid, prefs.tagNodoi]) {
        if (tag && item.hasTag(tag)) {
          item.removeTag(tag);
          changed = true;
        }
      }
      if (prefs.tagMultiple && !item.hasTag(prefs.tagMultiple)) {
        item.addTag(prefs.tagMultiple, 1);
        changed = true;
      }
      if (changed) saver.mark(item);
      return "multiple";
    }

    default:
      Zotero.debug(`DOI Manager: CrossRef returned unknown status`);
      return "skipped";
  }
}

function createRequestCache() {
  const requests = new Map();
  const fetch = (kind, url, request) => {
    const key = `${kind}:${url}`;
    if (!requests.has(key)) requests.set(key, request(url));
    return requests.get(key);
  };
  return {
    fetchDoiHandle: (url) => fetch("doi", url, DoiHttp.fetchDoiHandle),
    fetchCrossref: (url) => fetch("crossref", url, DoiHttp.fetchCrossref),
  };
}

async function ensureMultipleDoiAttachment(item, url) {
  const attachmentIDs = item.getAttachments?.() ?? [];
  const hasMatchingAttachment = attachmentIDs.some((id) => {
    const attachment = Zotero.Items.get(id);
    return attachment?.getField("url") === url;
  });
  if (hasMatchingAttachment) return;

  await Zotero.Attachments.linkFromURL({
    url,
    parentItemID: item.id,
    contentType: "text/html",
    title: "Multiple DOIs found",
  });
}

function createItemSaver() {
  const dirtyItems = new Set();
  return {
    mark(item) {
      dirtyItems.add(item);
    },
    async flush() {
      if (dirtyItems.size === 0) return;
      const saveItems = async (save) => {
        for (const item of dirtyItems) await save(item);
      };
      if (typeof Zotero.DB?.executeTransaction === "function") {
        await Zotero.DB.executeTransaction(() => saveItems((item) => item.save()));
      } else {
        await saveItems((item) => item.saveTx());
      }
    },
  };
}

function getConcurrencyLimit(prefs, total) {
  const configured = Number.parseInt(prefs.maxConcurrentRequests, 10);
  const maximum = Number.isFinite(configured)
    ? Math.min(Math.max(configured, 1), MAX_CONFIGURED_CONCURRENCY)
    : MAX_CONCURRENT_REQUESTS;
  const recommended = DoiHttp.getRecommendedConcurrency?.() ?? MAX_CONCURRENT_REQUESTS;
  return Math.min(total, maximum, recommended);
}

/**
 * Combine items into a pending batch with the same operation. This avoids
 * dropping auto-retrieve events while preserving the meaning of each command.
 */
function enqueueBatch(items, operation, rootURI) {
  let batch = pendingBatches.find(
    (candidate) => candidate.operation === operation && candidate.rootURI === rootURI
  );
  if (!batch) {
    batch = { operation, rootURI, items: [], itemKeys: new Set(), completions: [] };
    pendingBatches.push(batch);
  }
  for (const item of items) {
    const key = item.id ?? item.key ?? item;
    if (!batch.itemKeys.has(key)) {
      batch.itemKeys.add(key);
      batch.items.push(item);
    }
  }
  return new Promise((resolve) => batch.completions.push(resolve));
}

async function runBatch(items, operation, rootURI) {
  const { supported, unsupported } = partitionItems(items);
  if (unsupported.length > 0) showUnsupportedWarning(unsupported);
  if (supported.length === 0) return;

  const prefs = readPrefs();
  const counts = { updated: 0, invalid: 0, nodoi: 0, multiple: 0, failed: 0, skipped: 0 };
  const requestCache = createRequestCache();
  const saver = createItemSaver();
  const progressWindow = openProgressWindow(operation, rootURI);

  try {
    let nextIndex = 0;
    let completed = 0;
    const reportProgress = createProgressUpdater(progressWindow, supported.length);
    const worker = async () => {
      while (nextIndex < supported.length) {
        const item = supported[nextIndex++];
        let outcome = "skipped";
        try {
          outcome = await processItem(item, operation, prefs, requestCache, saver);
        } catch (error) {
          Zotero.debug(`DOI Manager: unexpected error processing item ${item.id}: ${error}`);
          outcome = "failed";
        }
        counts[outcome] = (counts[outcome] ?? 0) + 1;
        completed += 1;
        reportProgress(completed);
      }
    };
    await Promise.all(
      Array.from(
        { length: getConcurrencyLimit(prefs, supported.length) },
        worker
      )
    );
    await saver.flush();
    showCompletion(progressWindow, operation, { counts }, prefs);
  } catch (error) {
    Zotero.debug(`DOI Manager: unexpected error in update loop: ${error}`);
    if (progressWindow) progressWindow.close();
  }
}

async function drainBatches() {
  if (isRunning) return;
  isRunning = true;
  try {
    while (pendingBatches.length > 0) {
      const batch = pendingBatches.shift();
      try {
        await runBatch(batch.items, batch.operation, batch.rootURI);
      } catch (error) {
        Zotero.debug(`DOI Manager: unexpected error in queued update: ${error}`);
      } finally {
        for (const resolve of batch.completions) resolve();
      }
    }
  } finally {
    isRunning = false;
  }
}

/**
 * Run a DOI operation against the supplied items. Calls made while processing
 * are queued and coalesced by operation.
 *
 * @param {Zotero.Item[]} items
 * @param {"short" | "long" | "check"} operation
 * @param {string} rootURI  Plugin root URI (for icon paths in the progress window).
 */
function updateItems(items, operation, rootURI) {
  const completion = enqueueBatch(items, operation, rootURI);
  void drainBatches();
  return completion;
}

var DoiUpdater = Object.freeze({
  updateItems,
});
