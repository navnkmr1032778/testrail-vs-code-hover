const assert = require("node:assert/strict");
const test = require("node:test");
const {
  getApiUrl,
  getCaseApiUrl,
  getCaseWebUrl,
  normalizeBaseUrl,
} = require("../connection");

test("normalizes an HTTPS TestRail base URL and preserves a self-hosted path", () => {
  assert.equal(
    normalizeBaseUrl(" https://testrail.example.com/testrail/// "),
    "https://testrail.example.com/testrail",
  );
});

test("rejects insecure or credential-bearing base URLs", () => {
  assert.throws(() => normalizeBaseUrl("http://testrail.example.com"), /HTTPS/);
  assert.throws(() => normalizeBaseUrl("https://user:secret@testrail.example.com"), /credentials/);
  assert.throws(() => normalizeBaseUrl("https://testrail.example.com?redirect=elsewhere"), /query/);
});

test("builds API and browser URLs for a TestRail case", () => {
  const baseUrl = "https://testrail.example.com/testrail";
  assert.equal(
    getCaseApiUrl(baseUrl, "C1849545"),
    "https://testrail.example.com/testrail/index.php?/api/v2/get_case/1849545",
  );
  assert.equal(
    getCaseWebUrl(baseUrl, "C1849545"),
    "https://testrail.example.com/testrail/index.php?/cases/view/1849545",
  );
});

test("builds only validated TestRail API paths", () => {
  assert.equal(
    getApiUrl("https://testrail.example.com", "/api/v2/get_projects&offset=250"),
    "https://testrail.example.com/index.php?/api/v2/get_projects&offset=250",
  );
  assert.throws(() => getApiUrl("https://testrail.example.com", "https://evil.example/api/v2/get_case/1"), /Invalid/);
});

test("rejects case IDs outside the supported format", () => {
  assert.throws(() => getCaseApiUrl("https://testrail.example.com", "C123456"), /Invalid/);
});
