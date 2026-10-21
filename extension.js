const https = require("node:https");
const vscode = require("vscode");
const {
  caseIdAt,
  formatCase,
  INCLUDE_TEMPLATE_AND_MILESTONE_METADATA,
} = require("./caseDetails");
const { getApiUrl, normalizeBaseUrl } = require("./connection");

const BASE_URL_KEY = "testrailHover.baseUrl";
const USERNAME_KEY = "testrailHover.username";
const API_KEY_KEY = "testrailHover.apiKey";
const METADATA_CACHE_KEY = "testrailHover.metadataCache";
const METADATA_SCHEMA_VERSION = 5;
const DEFAULT_CACHE_TTL_MINUTES = 24 * 60;
const DEFAULT_CACHE_MAX_ENTRIES = 200;
const DEFAULT_REQUEST_INTERVAL_MS = 250;
const REQUEST_TIMEOUT_MS = 10 * 1000;
const MAX_RESPONSE_BYTES = 1024 * 1024;
const MAX_429_RETRIES = 3;
const METADATA_REFRESH_COOLDOWN_MS = 5 * 60 * 1000;

class TestRailHttpError extends Error {
  constructor(statusCode, retryAfterMs) {
    super(`TestRail returned HTTP ${statusCode}`);
    this.statusCode = statusCode;
    this.retryAfterMs = retryAfterMs;
  }
}

function delay(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

function retryAfterMilliseconds(value) {
  if (!value) return undefined;
  if (/^\d+$/.test(value)) return Number(value) * 1000;

  const timestamp = Date.parse(value);
  return Number.isNaN(timestamp) ? undefined : Math.max(0, timestamp - Date.now());
}

function createRequestQueue(getIntervalMilliseconds) {
  const pending = [];
  let sequence = 0;
  let running = false;
  let lastStartedAt = 0;

  const pump = async () => {
    if (running || !pending.length) return;
    running = true;

    const wait = Math.max(0, getIntervalMilliseconds() - (Date.now() - lastStartedAt));
    if (wait) await delay(wait);

    const next = pending.shift();
    if (!next) {
      running = false;
      return;
    }

    lastStartedAt = Date.now();
    try {
      next.resolve(await next.task());
    } catch (error) {
      next.reject(error);
    } finally {
      running = false;
      void pump();
    }
  };

  return (task, priority = 0) => new Promise((resolve, reject) => {
    pending.push({ task, priority, sequence: sequence += 1, resolve, reject });
    pending.sort((left, right) => right.priority - left.priority || left.sequence - right.sequence);
    void pump();
  });
}

function incrementMetric(requestQueue, name, amount = 1) {
  if (requestQueue.metrics) requestQueue.metrics[name] += amount;
}

function createMetadataStats(trigger) {
  return {
    trigger,
    startedAt: Date.now(),
    apiRequests: 0,
    paginationRequests: 0,
    rateLimitRetries: 0,
    projects: 0,
    suites: 0,
    status: "running",
  };
}

function logMetadataStats(stats, enabled) {
  if (!enabled) return;

  const details = [
    `trigger=${stats.trigger}`,
    `status=${stats.status}`,
    `elapsed=${(stats.elapsedMs / 1000).toFixed(2)}s`,
    `requests=${stats.apiRequests}`,
    `projects=${stats.projects}`,
    `suites=${stats.suites}`,
    `pagination=${stats.paginationRequests}`,
    `429Retries=${stats.rateLimitRetries}`,
  ];
  if (stats.error) details.push(`error=${stats.error}`);
  console.info(`[TestRail Hover] metadata ${details.join(" ")}`);
}

function trackedRequestQueue(requestQueue, metrics) {
  const tracked = (task, priority = 0) => {
    metrics.apiRequests += 1;
    return requestQueue(task, priority);
  };
  tracked.metrics = metrics;
  return tracked;
}

function requestJsonOnce(baseUrl, apiPath, username, apiKey) {
  const url = new URL(getApiUrl(baseUrl, apiPath));
  const authorization = Buffer.from(`${username}:${apiKey}`, "utf8").toString("base64");

  return new Promise((resolve, reject) => {
    let request;
    let settled = false;
    let responseBytes = 0;
    const chunks = [];
    const timeout = setTimeout(() => {
      request.destroy(new Error("TestRail request timed out"));
    }, REQUEST_TIMEOUT_MS);

    const finish = (error, value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      if (error) reject(error);
      else resolve(value);
    };

    request = https.get(
      url,
      {
        headers: {
          Accept: "application/json",
          Authorization: `Basic ${authorization}`,
        },
      },
      (response) => {
        response.on("data", (chunk) => {
          responseBytes += chunk.length;
          if (responseBytes > MAX_RESPONSE_BYTES) {
            request.destroy(new Error("TestRail response exceeded the size limit"));
            return;
          }
          chunks.push(chunk);
        });
        response.on("end", () => {
          const body = Buffer.concat(chunks).toString("utf8");
          if (response.statusCode < 200 || response.statusCode >= 300) {
            finish(new TestRailHttpError(
              response.statusCode,
              retryAfterMilliseconds(response.headers["retry-after"]),
            ));
            return;
          }
          try {
            finish(undefined, JSON.parse(body));
          } catch {
            finish(new Error("TestRail returned invalid JSON"));
          }
        });
        response.on("error", finish);
      },
    );

    request.setTimeout(REQUEST_TIMEOUT_MS, () => request.destroy(new Error("TestRail request timed out")));
    request.on("error", (error) => finish(error));
  });
}

async function getJson(baseUrl, apiPath, username, apiKey, requestQueue, priority = 0) {
  for (let attempt = 0; ; attempt += 1) {
    try {
      return await requestQueue(
        () => requestJsonOnce(baseUrl, apiPath, username, apiKey),
        priority,
      );
    } catch (error) {
      if (!(error instanceof TestRailHttpError) || error.statusCode !== 429 || attempt >= MAX_429_RETRIES) {
        throw error;
      }
      incrementMetric(requestQueue, "rateLimitRetries");
      const backoff = 1000 * (2 ** attempt);
      await delay(Math.max(error.retryAfterMs || 0, backoff));
    }
  }
}

function getCase(baseUrl, caseId, username, apiKey, requestQueue) {
  return getJson(
    baseUrl,
    `/api/v2/get_case/${caseId.slice(1)}`,
    username,
    apiKey,
    requestQueue,
    1,
  );
}

function nextApiPath(next, baseUrl) {
  if (!next) return undefined;
  if (next.startsWith("/api/v2/")) return next;

  try {
    const url = new URL(next, baseUrl);
    const path = url.search.startsWith("?") ? url.search.slice(1) : "";
    return path.startsWith("/api/v2/") ? path : undefined;
  } catch {
    return undefined;
  }
}

async function getCollection(baseUrl, apiPath, collectionKey, username, apiKey, requestQueue) {
  const records = [];
  const visited = new Set();
  let next = apiPath;

  while (next) {
    if (visited.has(next)) throw new Error("TestRail pagination loop detected");
    visited.add(next);
    if (next !== apiPath) incrementMetric(requestQueue, "paginationRequests");
    const payload = await getJson(baseUrl, next, username, apiKey, requestQueue);
    if (Array.isArray(payload)) return payload;

    const page = payload?.[collectionKey];
    if (!Array.isArray(page)) throw new Error(`TestRail response is missing '${collectionKey}'`);
    records.push(...page);
    next = nextApiPath(payload?._links?.next, baseUrl);
  }

  return records;
}

async function safeCollection(...argumentsList) {
  try {
    return await getCollection(...argumentsList);
  } catch {
    return [];
  }
}

function recordsByName(records) {
  return Object.fromEntries(
    records
      .filter((record) => record && record.id !== undefined)
      .map((record) => [String(record.id), record.name || record.email || `ID ${record.id}`]),
  );
}

function customFieldLookups(records) {
  const lookups = {};
  for (const record of records) {
    const fieldName = record?.system_name;
    if (!fieldName) continue;

    const configuredItems = (record.configs || [])
      .flatMap((config) => config?.options?.items ?? []);
    const items = Array.isArray(configuredItems)
      ? configuredItems
      : String(configuredItems || "").split(/\r?\n/);
    const lookup = {};

    items.forEach((item, index) => {
      if (item && typeof item === "object") {
        const id = item.id ?? item.value ?? index + 1;
        const label = item.name ?? item.label ?? item.text ?? item.value;
        if (label !== undefined && label !== null && String(label).trim()) {
          lookup[String(id)] = String(label).trim();
        }
        return;
      }

      const text = String(item).trim();
      if (!text) return;
      const match = text.match(/^(\d+)\s*[:|,\-]\s*(.+)$/);
      lookup[match ? match[1] : String(index + 1)] = match ? match[2].trim() : text;
    });

    lookups[fieldName] = lookup;
  }
  return lookups;
}

function sectionNames(records) {
  return Object.fromEntries(
    records
      .filter((record) => record?.id !== undefined && record.name)
      .map((record) => [String(record.id), record.name]),
  );
}

function emptyMetadata() {
  return {
    priorities: {},
    types: {},
    statuses: {},
    users: {},
    suites: {},
    suiteProjects: {},
    templates: {},
    milestones: {},
    sections: {},
    customFields: {},
  };
}

async function buildMetadata(baseUrl, username, apiKey, requestQueue) {
  const metadata = emptyMetadata();
  const [priorities, types, statuses, caseFields] = await Promise.all([
    safeCollection(baseUrl, "/api/v2/get_priorities", "priorities", username, apiKey, requestQueue),
    safeCollection(baseUrl, "/api/v2/get_case_types", "types", username, apiKey, requestQueue),
    safeCollection(baseUrl, "/api/v2/get_case_statuses", "statuses", username, apiKey, requestQueue),
    safeCollection(baseUrl, "/api/v2/get_case_fields", "case_fields", username, apiKey, requestQueue),
  ]);

  metadata.priorities = recordsByName(priorities);
  metadata.types = recordsByName(types);
  metadata.statuses = recordsByName(statuses);
  metadata.customFields = customFieldLookups(caseFields);

  return metadata;
}

function runPending(pending, key, task) {
  const existing = pending.get(key);
  if (existing) return existing;

  let promise;
  promise = Promise.resolve()
    .then(task)
    .finally(() => {
      if (pending.get(key) === promise) pending.delete(key);
    });
  pending.set(key, promise);
  return promise;
}

async function enrichMetadata(
  metadata,
  testCase,
  baseUrl,
  username,
  apiKey,
  requestQueue,
  pending,
  metadataKey,
) {
  const userIds = [testCase.created_by, testCase.updated_by]
    .filter((id) => id !== undefined && id !== null)
    .map(String);
  for (const userId of userIds) {
    if (metadata.users[userId]) continue;
    await runPending(pending, `${metadataKey}\u0000user\u0000${userId}`, async () => {
      if (metadata.users[userId]) return;
      try {
        const payload = await getJson(
          baseUrl,
          `/api/v2/get_user/${userId}`,
          username,
          apiKey,
          requestQueue,
        );
        const user = payload?.user || payload;
        const name = user?.name || user?.email;
        if (name) metadata.users[userId] = name;
      } catch {
        // Keep the numeric ID when the account cannot read this user.
      }
    });
  }

  const suiteId = testCase.suite_id === undefined ? undefined : String(testCase.suite_id);
  if (suiteId) {
    await runPending(pending, `${metadataKey}\u0000suite\u0000${suiteId}`, async () => {
      const projectId = await loadSuiteMetadata(
        metadata,
        suiteId,
        baseUrl,
        username,
        apiKey,
        requestQueue,
      );
      if (projectId) {
        await loadProjectMetadata(metadata, projectId, baseUrl, username, apiKey, requestQueue);
      }
    });
  }
}

async function loadProjectMetadata(metadata, projectId, baseUrl, username, apiKey, requestQueue) {
  if (!INCLUDE_TEMPLATE_AND_MILESTONE_METADATA) return;

  if (!metadata.templates[projectId]) {
    const templates = await safeCollection(
      baseUrl,
      `/api/v2/get_templates/${projectId}`,
      "templates",
      username,
      apiKey,
      requestQueue,
    );
    metadata.templates[projectId] = recordsByName(templates);
  }

  if (!metadata.milestones[projectId]) {
    const milestones = await safeCollection(
      baseUrl,
      `/api/v2/get_milestones/${projectId}`,
      "milestones",
      username,
      apiKey,
      requestQueue,
    );
    metadata.milestones[projectId] = recordsByName(milestones);
  }
}

async function loadSuiteMetadata(metadata, suiteId, baseUrl, username, apiKey, requestQueue) {
  let projectId = metadata.suiteProjects[suiteId];
  if (!metadata.suites[suiteId] || !projectId) {
    const payload = await getJson(
      baseUrl,
      `/api/v2/get_suite/${suiteId}`,
      username,
      apiKey,
      requestQueue,
    );
    const suite = payload?.suite || payload;
    if (suite?.name) metadata.suites[suiteId] = suite.name;
    if (suite?.project_id !== undefined) {
      projectId = String(suite.project_id);
      metadata.suiteProjects[suiteId] = projectId;
      incrementMetric(requestQueue, "projects");
    }
    incrementMetric(requestQueue, "suites");
  }

  if (!projectId || Object.prototype.hasOwnProperty.call(metadata.sections, suiteId)) return projectId;

  const sections = await safeCollection(
    baseUrl,
    `/api/v2/get_sections/${projectId}&suite_id=${suiteId}`,
    "sections",
    username,
    apiKey,
    requestQueue,
  );
  metadata.sections[suiteId] = sectionNames(sections);
  return projectId;
}

function lookupsForCase(metadata, testCase) {
  const suiteId = testCase.suite_id === undefined ? undefined : String(testCase.suite_id);
  const projectId = suiteId ? metadata.suiteProjects[suiteId] : undefined;
  return {
    priorities: metadata.priorities,
    types: metadata.types,
    statuses: metadata.statuses,
    users: metadata.users,
    suites: metadata.suites,
    sections: metadata.sections[suiteId] || {},
    templates: metadata.templates[projectId] || {},
    milestones: metadata.milestones[projectId] || {},
    customFields: metadata.customFields,
  };
}

const METADATA_CONTENT_FIELDS = new Set([
  "custom_preconds",
  "custom_steps",
  "custom_steps_separated",
  "custom_expected",
]);

function hasMetadataValue(value) {
  return value !== undefined && value !== null && value !== ""
    && (!Array.isArray(value) || value.length > 0);
}

function lookupValuesMissing(value, lookup) {
  if (!lookup) return true;
  const values = Array.isArray(value) ? value : [value];
  return values.some((item) => {
    const id = item && typeof item === "object"
      ? item.id ?? item.value ?? item.name
      : item;
    return id !== undefined && id !== null
      && !Object.prototype.hasOwnProperty.call(lookup, String(id));
  });
}

function metadataNeedsRefresh(metadata, testCase) {
  const suiteId = testCase.suite_id === undefined ? undefined : String(testCase.suite_id);
  const projectId = suiteId ? metadata.suiteProjects[suiteId] : undefined;
  const lookups = {
    priority_id: metadata.priorities,
    type_id: metadata.types,
    status_id: metadata.statuses,
    suite_id: metadata.suites,
    section_id: suiteId ? metadata.sections[suiteId] : undefined,
  };
  if (INCLUDE_TEMPLATE_AND_MILESTONE_METADATA) {
    lookups.template_id = projectId ? metadata.templates[projectId] : undefined;
    lookups.milestone_id = projectId ? metadata.milestones[projectId] : undefined;
  }

  for (const [field, lookup] of Object.entries(lookups)) {
    if (hasMetadataValue(testCase[field]) && lookupValuesMissing(testCase[field], lookup)) {
      return true;
    }
  }

  for (const [field, value] of Object.entries(testCase)) {
    if (!field.startsWith("custom_") || METADATA_CONTENT_FIELDS.has(field) || !hasMetadataValue(value)) {
      continue;
    }
    if (!Object.prototype.hasOwnProperty.call(metadata.customFields, field)) return true;
    const lookup = metadata.customFields[field];
    if (Object.keys(lookup).length && lookupValuesMissing(value, lookup)) return true;
  }

  return false;
}

function markdown(text) {
  const result = new vscode.MarkdownString(text);
  result.isTrusted = false;
  return result;
}

function cacheSettings() {
  const configuration = vscode.workspace.getConfiguration("testrailHover");
  const configuredTtl = Number(configuration.get("cacheTtlMinutes", DEFAULT_CACHE_TTL_MINUTES));
  const configuredMaxEntries = Number(configuration.get("cacheMaxEntries", DEFAULT_CACHE_MAX_ENTRIES));
  const configuredInterval = Number(configuration.get("requestIntervalMs", DEFAULT_REQUEST_INTERVAL_MS));

  return {
    ttlMs: (Number.isFinite(configuredTtl) ? Math.max(1, configuredTtl) : DEFAULT_CACHE_TTL_MINUTES) * 60 * 1000,
    maxEntries: Number.isFinite(configuredMaxEntries)
      ? Math.min(1000, Math.max(1, Math.floor(configuredMaxEntries)))
      : DEFAULT_CACHE_MAX_ENTRIES,
    requestIntervalMs: Number.isFinite(configuredInterval)
      ? Math.min(5000, Math.max(100, Math.floor(configuredInterval)))
      : DEFAULT_REQUEST_INTERVAL_MS,
    persistMetadata: configuration.get("persistMetadata", true) !== false,
    debugLogging: configuration.get("debugLogging", false) === true,
  };
}

function trimCache(cache, maxEntries) {
  while (cache.size > maxEntries) {
    cache.delete(cache.keys().next().value);
  }
}

function activate(context) {
  const cache = new Map();
  const pending = new Map();
  const metadataCache = new Map();
  const metadataPending = new Map();
  const metadataPartPending = new Map();
  const metadataRefreshPending = new Map();
  const metadataRefreshAt = new Map();
  let metadataGeneration = 0;
  let caseGeneration = 0;
  const requestQueue = createRequestQueue(() => cacheSettings().requestIntervalMs);

  const clearMemory = async (preserveMetadata = false) => {
    caseGeneration += 1;
    cache.clear();
    pending.clear();
    if (preserveMetadata) return;

    metadataGeneration += 1;
    metadataCache.clear();
    metadataPending.clear();
    metadataPartPending.clear();
    metadataRefreshPending.clear();
    metadataRefreshAt.clear();
    await context.globalState.update(METADATA_CACHE_KEY, undefined);
  };

  const refreshMetadataInBackground = (
    baseUrl,
    username,
    apiKey,
    settings,
    { force = false, progress, reportErrors = false, trigger = "background" } = {},
  ) => {
    const metadataKey = `${baseUrl}\u0000${username}`;
    const lastRefreshAt = metadataRefreshAt.get(metadataKey) || 0;
    if (!force && Date.now() - lastRefreshAt < METADATA_REFRESH_COOLDOWN_MS) return;

    const existing = metadataRefreshPending.get(metadataKey);
    if (existing) return existing;

    const generation = metadataGeneration;
    const stats = createMetadataStats(trigger);
    const metadataRequestQueue = trackedRequestQueue(requestQueue, stats);
    let status = "success";
    let errorMessage;
    let refreshPromise;
    refreshPromise = (async () => {
      try {
        progress?.report({ message: "Loading shared metadata..." });
        const data = await buildMetadata(baseUrl, username, apiKey, metadataRequestQueue);
        const stored = settings.persistMetadata
          ? context.globalState.get(METADATA_CACHE_KEY)
          : undefined;
        const previous = metadataCache.get(metadataKey)?.data
          || (stored?.schema === METADATA_SCHEMA_VERSION && stored.key === metadataKey
            ? stored.data
            : undefined);
        data.users = { ...(previous?.users || {}) };
        const loadedSuiteIds = Object.keys(previous?.suiteProjects || {});
        for (let index = 0; index < loadedSuiteIds.length; index += 1) {
          const suiteId = loadedSuiteIds[index];
          const projectId = await loadSuiteMetadata(
            data,
            suiteId,
            baseUrl,
            username,
            apiKey,
            metadataRequestQueue,
          );
          if (projectId) {
            await loadProjectMetadata(
              data,
              projectId,
              baseUrl,
              username,
              apiKey,
              metadataRequestQueue,
            );
          }
          progress?.report({
            message: `Refreshing suite metadata (${index + 1}/${loadedSuiteIds.length})...`,
          });
        }
        if (generation !== metadataGeneration) {
          status = "discarded";
          return;
        }

        const entry = { createdAt: Date.now(), data };
        metadataCache.set(metadataKey, entry);
        if (settings.persistMetadata) {
          await context.globalState.update(METADATA_CACHE_KEY, {
            schema: METADATA_SCHEMA_VERSION,
            key: metadataKey,
            createdAt: entry.createdAt,
            data,
          });
        }
      } catch (error) {
        // The existing metadata remains usable; retry after the cooldown.
        status = "failed";
        errorMessage = error.message;
        if (reportErrors) throw error;
      } finally {
        stats.status = status;
        stats.elapsedMs = Date.now() - stats.startedAt;
        if (errorMessage) stats.error = errorMessage;
        logMetadataStats(stats, settings.debugLogging);
        metadataRefreshAt.set(metadataKey, Date.now());
        if (metadataRefreshPending.get(metadataKey) === refreshPromise) {
          metadataRefreshPending.delete(metadataKey);
        }
      }
    })();
    metadataRefreshPending.set(metadataKey, refreshPromise);
    return refreshPromise;
  };

  const loadMetadata = async (
    baseUrl,
    username,
    apiKey,
    settings,
    generation,
    metadataRequestQueue = requestQueue,
  ) => {
    const metadataKey = `${baseUrl}\u0000${username}`;
    const cached = metadataCache.get(metadataKey);
    if (cached) {
      if (Date.now() - cached.createdAt < settings.ttlMs) return cached.data;
      refreshMetadataInBackground(baseUrl, username, apiKey, settings, { trigger: "ttl" });
      return cached.data;
    }

    if (settings.persistMetadata) {
      const stored = context.globalState.get(METADATA_CACHE_KEY);
      if (
        stored?.schema === METADATA_SCHEMA_VERSION
        && stored.key === metadataKey
      ) {
        const entry = { createdAt: stored.createdAt, data: stored.data };
        metadataCache.set(metadataKey, entry);
        if (Date.now() - entry.createdAt >= settings.ttlMs) {
          refreshMetadataInBackground(baseUrl, username, apiKey, settings, { trigger: "ttl" });
        }
        return entry.data;
      }
    }

    const existing = metadataPending.get(metadataKey);
    if (existing) return existing;

    let metadataPromise;
    metadataPromise = (async () => {
      const data = await buildMetadata(baseUrl, username, apiKey, metadataRequestQueue);
      if (generation !== metadataGeneration) return data;

      const entry = { createdAt: Date.now(), data };
      metadataCache.set(metadataKey, entry);
      return data;
    })().finally(() => {
      if (metadataPending.get(metadataKey) === metadataPromise) metadataPending.delete(metadataKey);
    });
    metadataPending.set(metadataKey, metadataPromise);
    return metadataPromise;
  };

  const persistMetadata = async (metadataKey, metadata, settings, generation) => {
    if (!settings.persistMetadata || generation !== metadataGeneration) return;
    const entry = metadataCache.get(metadataKey);
    if (!entry || entry.data !== metadata) return;
    await context.globalState.update(METADATA_CACHE_KEY, {
      schema: METADATA_SCHEMA_VERSION,
      key: metadataKey,
      createdAt: entry.createdAt,
      data: metadata,
    });
  };

  const refreshConfiguredMetadata = async () => {
    const configuredBaseUrl = context.globalState.get(BASE_URL_KEY);
    const username = context.globalState.get(USERNAME_KEY)
      || await context.secrets.get(USERNAME_KEY);
    const apiKey = await context.secrets.get(API_KEY_KEY);
    if (!configuredBaseUrl || !username || !apiKey) return false;

    const baseUrl = normalizeBaseUrl(configuredBaseUrl);
    const settings = cacheSettings();
    await vscode.window.withProgress(
      {
        location: vscode.ProgressLocation.Notification,
        title: "Refreshing TestRail metadata",
        cancellable: false,
      },
      (progress) => refreshMetadataInBackground(
        baseUrl,
        username,
        apiKey,
        settings,
        { force: true, progress, reportErrors: true, trigger: "explicit" },
      ),
    );
    await clearMemory(true);
    return true;
  };

  const prepareMetadataForCase = (
    baseUrl,
    username,
    apiKey,
    data,
    settings,
  ) => {
    const generation = metadataGeneration;
    void (async () => {
      try {
        const metadata = await loadMetadata(
          baseUrl,
          username,
          apiKey,
          settings,
          generation,
        );
        const metadataKey = `${baseUrl}\u0000${username}`;
        await enrichMetadata(
          metadata,
          data,
          baseUrl,
          username,
          apiKey,
          requestQueue,
          metadataPartPending,
          metadataKey,
        );
        if (metadataNeedsRefresh(metadata, data)) {
          refreshMetadataInBackground(
            baseUrl,
            username,
            apiKey,
            settings,
            { trigger: "signal" },
          );
        }
        await persistMetadata(
          metadataKey,
          metadata,
          settings,
          generation,
        );
      } catch (error) {
        if (settings.debugLogging) {
          console.warn(`[TestRail Hover] background metadata load failed: ${error.message}`);
        }
      }
    })();
  };

  context.subscriptions.push(
    vscode.commands.registerCommand("testrailHover.configure", async () => {
      const savedBaseUrl = context.globalState.get(BASE_URL_KEY, "");
      const savedUsername = context.globalState.get(USERNAME_KEY)
        || await context.secrets.get(USERNAME_KEY)
        || "";

      const baseUrlInput = await vscode.window.showInputBox({
        prompt: "TestRail base URL (HTTPS)",
        value: savedBaseUrl,
        placeHolder: "https://testrail.example.com",
        ignoreFocusOut: true,
      });
      if (baseUrlInput === undefined) return;

      let baseUrl;
      try {
        baseUrl = normalizeBaseUrl(baseUrlInput);
      } catch (error) {
        vscode.window.showErrorMessage(error.message);
        return;
      }

      const username = await vscode.window.showInputBox({
        prompt: "TestRail username/email",
        value: savedUsername,
        ignoreFocusOut: true,
      });
      if (!username || !username.trim()) return;

      const apiKey = await vscode.window.showInputBox({
        prompt: "TestRail API key",
        password: true,
        ignoreFocusOut: true,
      });
      if (!apiKey) return;

      await context.globalState.update(BASE_URL_KEY, baseUrl);
      await context.globalState.update(USERNAME_KEY, username.trim());
      await context.secrets.delete(USERNAME_KEY);
      await context.secrets.store(API_KEY_KEY, apiKey);
      await clearMemory();
      vscode.window.showInformationMessage(
        "TestRail Hover credentials saved. Metadata will load when a case is hovered.",
      );
    }),
  );

  context.subscriptions.push(
    vscode.commands.registerCommand("testrailHover.refreshMetadata", async () => {
      try {
        const refreshed = await refreshConfiguredMetadata();
        vscode.window.showInformationMessage(
          refreshed
            ? "TestRail Hover metadata refreshed."
            : "Configure the TestRail connection first.",
        );
      } catch (error) {
        vscode.window.showErrorMessage(`TestRail Hover metadata refresh failed: ${error.message}`);
      }
    }),
    vscode.commands.registerCommand("testrailHover.clearCache", async () => {
      await clearMemory(true);
      vscode.window.showInformationMessage("TestRail Hover case cache cleared.");
    }),
  );

  const deleteConfiguration = async () => {
    const confirmation = await vscode.window.showWarningMessage(
      "Delete the saved TestRail base URL, username, API key, and cached case details?",
      { modal: true },
      "Delete Credentials",
    );
    if (confirmation !== "Delete Credentials") return;

    await context.globalState.update(BASE_URL_KEY, undefined);
    await context.globalState.update(USERNAME_KEY, undefined);
    await context.secrets.delete(USERNAME_KEY);
    await context.secrets.delete(API_KEY_KEY);
    await clearMemory();
    vscode.window.showInformationMessage("TestRail Hover credentials deleted.");
  };

  context.subscriptions.push(
    vscode.commands.registerCommand("testrailHover.deleteConfiguration", deleteConfiguration),
    // Keep the old command ID working for existing keybindings.
    vscode.commands.registerCommand("testrailHover.clearCredentials", deleteConfiguration),
  );

  context.subscriptions.push(
    vscode.languages.registerHoverProvider({ scheme: "file" }, {
      async provideHover(document, position) {
        const caseId = caseIdAt(document.lineAt(position.line).text, position.character);
        if (!caseId) return undefined;

        const configuredBaseUrl = context.globalState.get(BASE_URL_KEY);
        if (!configuredBaseUrl) {
          return new vscode.Hover(markdown("Run **TestRail Hover: Save Credentials** first."));
        }

        let baseUrl;
        try {
          baseUrl = normalizeBaseUrl(configuredBaseUrl);
        } catch {
          return new vscode.Hover(markdown("Saved TestRail URL is invalid. Run **TestRail Hover: Save Credentials** again."));
        }

        const settings = cacheSettings();
        trimCache(cache, settings.maxEntries);
        const cacheKey = `${baseUrl}\u0000${caseId}`;
        const username = context.globalState.get(USERNAME_KEY)
          || await context.secrets.get(USERNAME_KEY);
        const apiKey = await context.secrets.get(API_KEY_KEY);
        const cached = cache.get(cacheKey);
        if (cached && Date.now() - cached.createdAt < settings.ttlMs) {
          cache.delete(cacheKey);
          cache.set(cacheKey, cached);
          if (username && apiKey) {
            prepareMetadataForCase(baseUrl, username, apiKey, cached.data, settings);
          }
          const metadataEntry = username
            ? metadataCache.get(`${baseUrl}\u0000${username}`)
            : undefined;
          const text = formatCase(
            cached.data,
            caseId,
            baseUrl,
            metadataEntry ? lookupsForCase(metadataEntry.data, cached.data) : {},
          );
          return new vscode.Hover(markdown(text));
        }
        if (cached) {
          cache.delete(cacheKey);
        }

        if (!username || !apiKey) {
          return new vscode.Hover(markdown("Run **TestRail Hover: Save Credentials** first."));
        }

        try {
          const caseGenerationAtStart = caseGeneration;
          const request = pending.get(cacheKey) || (async () => {
            const data = await getCase(baseUrl, caseId, username, apiKey, requestQueue);
            if (caseGenerationAtStart === caseGeneration) {
              cache.set(cacheKey, { data, createdAt: Date.now() });
            }
            trimCache(cache, settings.maxEntries);
            prepareMetadataForCase(baseUrl, username, apiKey, data, settings);
            return data;
          })();
          pending.set(cacheKey, request);
          const data = await request;
          const metadataEntry = metadataCache.get(`${baseUrl}\u0000${username}`);
          const text = formatCase(
            data,
            caseId,
            baseUrl,
            metadataEntry ? lookupsForCase(metadataEntry.data, data) : {},
          );
          return new vscode.Hover(markdown(text));
        } catch (error) {
          return new vscode.Hover(markdown(`Unable to load **${caseId}**: ${error.message}`));
        } finally {
          if (pending.get(cacheKey)) pending.delete(cacheKey);
        }
      },
    }),
  );
}

function deactivate() {}

module.exports = { activate, deactivate };
