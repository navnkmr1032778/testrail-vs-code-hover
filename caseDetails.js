const CASE_ID_PATTERN = /\bC\d{7}\b/g;
const { getCaseWebUrl } = require("./connection");

// shortcut: templates and milestones disabled to remove two project requests, enable when required.
const INCLUDE_TEMPLATE_AND_MILESTONE_METADATA = false;

function caseIdAt(line, character) {
  for (const match of line.matchAll(CASE_ID_PATTERN)) {
    const start = match.index ?? -1;
    if (character >= start && character < start + match[0].length) {
      return match[0];
    }
  }
  return undefined;
}

const HTML_ENTITIES = {
  amp: "&",
  apos: "'",
  gt: ">",
  lt: "<",
  nbsp: " ",
  quot: '"',
};

function htmlToText(value) {
  return String(value ?? "")
    .replace(/<br\s*\/?>(?=\s*)/gi, "\n")
    .replace(/<li\b[^>]*>/gi, "- ")
    .replace(/<\/(?:p|div|li|h[1-6])>/gi, "\n")
    .replace(/<[^>]+>/g, "")
    .replace(/&(#x[\da-f]+|#\d+|[a-z]+);/gi, (_, entity) => {
      if (entity.toLowerCase().startsWith("#x")) {
        return String.fromCodePoint(parseInt(entity.slice(2), 16));
      }
      if (entity.startsWith("#")) {
        return String.fromCodePoint(parseInt(entity.slice(1), 10));
      }
      return HTML_ENTITIES[entity.toLowerCase()] || `&${entity};`;
    })
    .replace(/\r/g, "")
    .replace(/[ \t]+\n/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

function inline(value) {
  return String(value)
    .replace(/\r?\n/g, " ")
    .replace(/([\\`*_\[\]()<>#+.!|])/g, "\\$1");
}

function detail(value) {
  return String(value).replace(/```/g, "'''");
}

function formatSteps(value) {
  if (!Array.isArray(value)) return htmlToText(value);

  return value
    .map((step, index) => {
      const content = htmlToText(step.content || step.step);
      const expected = htmlToText(step.expected);
      const expectedLines = expected.replace(/\n/g, "\n   ");
      return `${index + 1}. ${content}${expected ? `\n   Expected: ${expectedLines}` : ""}`;
    })
    .join("\n");
}

const METADATA_FIELDS = [
  ["Suite", "suite_id"],
  ["Section", "section_id"],
  ["Priority", "priority_id"],
  ["Automation type", "custom_automation_type"],
  ["Automated Platforms", "custom_automated_platforms"],
  ["Supporting Platforms", "custom_supporting_platforms"],
  ["Status", "status_id"],
  ["Type", "type_id"],
  ["Template", "template_id"],
  ["Milestone", "milestone_id"],
  ["References", "refs"],
  ["Estimate", "estimate"],
  ["Estimate forecast", "estimate_forecast"],
  ["Created by", "created_by"],
  ["Created", "created_on"],
  ["Updated by", "updated_by"],
  ["Updated", "updated_on"],
  ["Mission", "custom_mission"],
].filter(([, key]) => INCLUDE_TEMPLATE_AND_MILESTONE_METADATA
  || !["template_id", "milestone_id"].includes(key));

const CONTENT_FIELDS = new Set([
  "custom_preconds",
  "custom_steps",
  "custom_steps_separated",
  "custom_expected",
]);
const METADATA_KEYS = new Set(METADATA_FIELDS.map(([, key]) => key));

function fieldLabel(key) {
  return key
    .replace(/^custom_/, "")
    .replace(/_/g, " ")
    .replace(/\b\w/g, (letter) => letter.toUpperCase());
}

function fieldText(value) {
  if (Array.isArray(value)) {
    if (value.every((item) => item && typeof item === "object" && (item.content || item.step))) {
      return formatSteps(value);
    }
    return value
      .map((item) => (item && typeof item === "object"
        ? item.name ?? item.label ?? item.text ?? item.value
        : item))
      .filter((item) => item !== undefined && item !== null && String(item).trim())
      .map((item) => htmlToText(item))
      .join(", ");
  }
  if (typeof value === "string") return htmlToText(value);
  return JSON.stringify(value, null, 2);
}

function lookupText(value, lookup) {
  if (Array.isArray(value)) return value.map((item) => lookupText(item, lookup)).join(", ");
  const name = lookup?.[String(value)];
  return name || String(value);
}

function hasValue(value) {
  if (value === undefined || value === null || value === "") return false;
  if (Array.isArray(value)) return value.some(hasValue);
  return typeof value === "string" ? htmlToText(value) !== "" : true;
}

function timestampText(value) {
  const timestamp = Number(value);
  if (!Number.isFinite(timestamp)) return String(value);

  const date = new Date(timestamp * 1000);
  if (Number.isNaN(date.getTime())) return String(value);
  return new Intl.DateTimeFormat(undefined, {
    dateStyle: "medium",
    timeStyle: "short",
  }).format(date);
}

function metadataText(key, value, lookups) {
  const lookupKeys = {
    status_id: "statuses",
    priority_id: "priorities",
    type_id: "types",
    section_id: "sections",
    suite_id: "suites",
    template_id: "templates",
    milestone_id: "milestones",
    created_by: "users",
    updated_by: "users",
  };

  if (key === "created_on" || key === "updated_on") return timestampText(value);
  if (lookupKeys[key]) return lookupText(value, lookups?.[lookupKeys[key]]);
  const customLookup = lookups?.customFields?.[key];
  if (customLookup && Object.keys(customLookup).length) return lookupText(value, customLookup);
  return fieldText(value);
}

function formatCase(testCase, caseId, domain, lookups = {}) {
  const lines = [
    `**${caseId} — ${inline(testCase.title || "Untitled case")}**`,
    `[Open in TestRail](${getCaseWebUrl(domain, caseId)})`,
  ];

  const metadata = METADATA_FIELDS
    .filter(([, key]) => hasValue(testCase[key]))
    .map(([label, key]) => `- ${label}: ${inline(metadataText(key, testCase[key], lookups))}`);
  if (metadata.length) lines.push(`\n**Details**\n\n${metadata.join("\n")}`);

  for (const [label, value] of [
    ["Preconditions", htmlToText(testCase.custom_preconds)],
    ["Steps", formatSteps(testCase.custom_steps || testCase.custom_steps_separated)],
    ["Expected result", htmlToText(testCase.custom_expected)],
  ]) {
    const text = detail(value);
    if (text) lines.push(`\n**${label}**\n\n\`\`\`\n${text}\n\`\`\``);
  }

  const additionalFields = Object.entries(testCase)
    .filter(([key, value]) => key.startsWith("custom_") && !CONTENT_FIELDS.has(key) && !METADATA_KEYS.has(key) && hasValue(value))
    .map(([key, value]) => [fieldLabel(key), detail(fieldText(value))]);
  for (const [label, text] of additionalFields) {
    lines.push(`\n**${label}**\n\n\`\`\`\n${text}\n\`\`\``);
  }

  return lines.join("\n");
}

module.exports = {
  caseIdAt,
  formatCase,
  INCLUDE_TEMPLATE_AND_MILESTONE_METADATA,
};
