const CASE_ID_PATTERN = /^C\d{7}$/;

function normalizeBaseUrl(value) {
  if (typeof value !== "string" || !value.trim()) {
    throw new Error("A TestRail base URL is required.");
  }

  const text = value.trim();
  if (/[?#]/.test(text)) {
    throw new Error("The TestRail base URL must not contain a query or fragment.");
  }

  let url;
  try {
    url = new URL(text);
  } catch {
    throw new Error("Enter a valid TestRail HTTPS URL.");
  }

  if (url.protocol !== "https:" || !url.hostname) {
    throw new Error("The TestRail base URL must use HTTPS.");
  }
  if (url.username || url.password) {
    throw new Error("The TestRail base URL must not contain credentials.");
  }

  url.pathname = url.pathname.replace(/\/+$/, "");
  return url.toString().replace(/\/$/, "");
}

function caseNumber(caseId) {
  if (!CASE_ID_PATTERN.test(caseId)) {
    throw new Error("Invalid TestRail case ID.");
  }
  return caseId.slice(1);
}

function getApiUrl(baseUrl, apiPath) {
  if (typeof apiPath !== "string" || !/^\/api\/v2\/[a-z0-9_/?=&.%-]+$/i.test(apiPath)) {
    throw new Error("Invalid TestRail API path.");
  }
  return `${normalizeBaseUrl(baseUrl)}/index.php?${apiPath}`;
}

function getCaseApiUrl(baseUrl, caseId) {
  return getApiUrl(baseUrl, `/api/v2/get_case/${caseNumber(caseId)}`);
}

function getCaseWebUrl(baseUrl, caseId) {
  return `${normalizeBaseUrl(baseUrl)}/index.php?/cases/view/${caseNumber(caseId)}`;
}

module.exports = { getApiUrl, getCaseApiUrl, getCaseWebUrl, normalizeBaseUrl };
