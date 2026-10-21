const assert = require("node:assert/strict");
const test = require("node:test");
const { caseIdAt, formatCase } = require("../caseDetails");

test("finds only seven-digit TestRail IDs under the hover position", () => {
  const line = "pytest.mark.testrail('C1849545')";
  assert.equal(caseIdAt(line, line.indexOf("C1849545") + 3), "C1849545");
  assert.equal(caseIdAt("C123456", 3), undefined);
});

test("formats the case title and details", () => {
  const output = formatCase(
    {
      title: "Bet cashout",
      custom_preconds: "<p>Logged in User</p>",
      custom_steps_separated: [
        {
          content: "<p>Validate the game launch</p>",
          expected: "<p>Game Name should be displayed<br />Bet amount should be displayed</p>",
        },
      ],
      section_id: 12,
      custom_automation_type: "<p>Automated</p>",
      custom_browser: "Chromium",
    },
    "C1849545",
    "https://testrail.example.com",
  );
  assert.match(output, /Bet cashout/);
  assert.match(output, /1\. Validate the game launch/);
  assert.match(output, /Expected: Game Name should be displayed\n   Bet amount should be displayed/);
  assert.match(output, /Section: 12/);
  assert.match(output, /Automation type/);
  assert.match(output, /Browser/);
  assert.doesNotMatch(output, /<p>|<br|custom_steps_separated/);
  assert.match(output, /testrail\.example\.com\/index\.php\?\/cases\/view\/1849545/);
});

test("formats lookup metadata and timestamps for a case", () => {
  const output = formatCase(
    {
      title: "Launch game",
      priority_id: 3,
      type_id: 6,
      section_id: 12,
      suite_id: 34,
      created_by: 52,
      created_on: 0,
    },
    "C1849545",
    "https://testrail.example.com",
    {
      priorities: { "3": "Critical" },
      types: { "6": "Functional" },
      sections: { "12": "Jungle Run" },
      suites: { "34": "Crash Games" },
      users: { "52": "Naveen" },
    },
  );

  assert.match(output, /Priority: Critical/);
  assert.match(output, /Type: Functional/);
  assert.match(output, /Section: Jungle Run/);
  assert.match(output, /Suite: Crash Games/);
  assert.match(output, /Created by: Naveen/);
  assert.doesNotMatch(output, /\(ID:/);
  assert.doesNotMatch(output, /Created: 0/);
});

test("formats custom field option labels", () => {
  const output = formatCase(
    { title: "Launch game", custom_automation_type: 1 },
    "C1849545",
    "https://testrail.example.com",
    { customFields: { custom_automation_type: { "1": "Automated" } } },
  );

  assert.match(output, /Automation type: Automated/);
});

test("formats known free-text custom fields with an empty lookup", () => {
  const output = formatCase(
    { title: "Launch game", custom_mission: "Regression" },
    "C1849545",
    "https://testrail.example.com",
    { customFields: { custom_mission: {} } },
  );

  assert.match(output, /Mission: Regression/);
});

test("omits disabled template and milestone metadata", () => {
  const output = formatCase(
    { title: "Launch game", template_id: 2, milestone_id: 9 },
    "C1849545",
    "https://testrail.example.com",
  );

  assert.doesNotMatch(output, /Template:/);
  assert.doesNotMatch(output, /Milestone:/);
});

test("orders optional platform details and omits absent fields", () => {
  const output = formatCase(
    {
      title: "Launch game",
      suite_id: 34,
      section_id: 12,
      priority_id: 3,
      custom_automation_type: 1,
      custom_automated_platforms: [1, 2],
    },
    "C1849545",
    "https://testrail.example.com",
    {
      suites: { "34": "Crash Games" },
      sections: { "12": "Jungle Run" },
      priorities: { "3": "High" },
      customFields: {
        custom_automation_type: { "1": "Automated" },
        custom_automated_platforms: { "1": "API", "2": "WAP" },
      },
    },
  );

  assert.ok(output.indexOf("Suite:") < output.indexOf("Section:"));
  assert.ok(output.indexOf("Section:") < output.indexOf("Priority:"));
  assert.ok(output.indexOf("Priority:") < output.indexOf("Automation type:"));
  assert.ok(output.indexOf("Automation type:") < output.indexOf("Automated Platforms:"));
  assert.match(output, /Section: Jungle Run/);
  assert.match(output, /Automated Platforms: API, WAP/);
  assert.doesNotMatch(output, /Supporting Platforms:/);
});
