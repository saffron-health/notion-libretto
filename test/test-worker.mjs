#!/usr/bin/env node
// Smoke-tests the deployed insert-into-database worker against both test
// databases, then verifies via the Notion API that each row actually landed.
//
// Run from repo root with:
//   node --env-file=.env test/test-worker.mjs
//   node --env-file=.env test/test-worker.mjs marketplace
//   node --env-file=.env test/test-worker.mjs social

const WEBHOOK_URL = process.env.WEBHOOK_URL;
const MARKETPLACE_DB_ID = process.env.MARKETPLACE_DB_ID;
const SOCIAL_DB_ID = process.env.SOCIAL_DB_ID;
const NOTION_API_TOKEN = process.env.NOTION_API_TOKEN;
const NOTION_API_VERSION = "2025-09-03";

for (const [k, v] of Object.entries({
  WEBHOOK_URL,
  MARKETPLACE_DB_ID,
  SOCIAL_DB_ID,
  NOTION_API_TOKEN,
})) {
  if (!v) {
    console.error(`Missing env var: ${k}. Run with --env-file=.env from repo root.`);
    process.exit(1);
  }
}

const stamp = new Date().toISOString();

const cases = {
  marketplace: {
    database_id: MARKETPLACE_DB_ID,
    titleProperty: "Title",
    data: {
      Title: `Mid-century chair (${stamp})`,
      URL: "https://example.com/listing/123",
      Price: 240,
      Location: "Brooklyn, NY",
      Posted: "2026-05-15",
      Category: "Furniture",
      Tags: ["urgent", "cheap"],
      Available: true,
    },
  },
  social: {
    database_id: SOCIAL_DB_ID,
    titleProperty: "Post",
    data: {
      Post: `Test mention (${stamp})`,
      Author: "Jane Doe",
      Platform: "LinkedIn",
      "Author Email": "jane@example.com",
      "Post URL": "https://linkedin.com/posts/jane/123",
      "Sentiment Score": 0.74,
      "Captured At": "2026-05-16",
      "Worth Replying": true,
      Notes: "Mentions our competitor positively",
    },
  },
};

async function notion(method, path, body) {
  const res = await fetch(`https://api.notion.com/v1${path}`, {
    method,
    headers: {
      Authorization: `Bearer ${NOTION_API_TOKEN}`,
      "Notion-Version": NOTION_API_VERSION,
      "Content-Type": "application/json",
    },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
  const text = await res.text();
  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch {
    parsed = text;
  }
  if (!res.ok) {
    throw new Error(`Notion ${method} ${path} failed: ${res.status} ${text}`);
  }
  return parsed;
}

async function resolveDataSource(databaseId) {
  const db = await notion("GET", `/databases/${databaseId}`);
  const id = db.data_sources?.[0]?.id;
  if (!id) throw new Error(`No data source on database ${databaseId}`);
  return id;
}

async function findRow(dataSourceId, titleProperty, needle, timeoutMs = 15_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const res = await notion("POST", `/data_sources/${dataSourceId}/query`, {
      filter: { property: titleProperty, title: { contains: needle } },
      page_size: 5,
    });
    if (Array.isArray(res.results) && res.results.length > 0) {
      return res.results[0];
    }
    await new Promise((r) => setTimeout(r, 1500));
  }
  return null;
}

async function run(name, c) {
  console.log(`\n— ${name} —`);
  console.log(`POST → 202 Accepted expected`);

  const res = await fetch(WEBHOOK_URL, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ database_id: c.database_id, data: c.data }),
  });
  const text = await res.text();
  console.log(`  delivery: ${res.status} ${res.statusText} ${text}`);
  if (!res.ok) {
    console.log(`  FAIL: webhook did not accept the event`);
    return false;
  }

  console.log(`  verifying row appears in Notion (up to 15s)…`);
  const dataSourceId = await resolveDataSource(c.database_id);
  const row = await findRow(dataSourceId, c.titleProperty, stamp);
  if (!row) {
    console.log(`  FAIL: no row with "${stamp}" found in ${c.database_id}`);
    console.log(`        → check 'ntn workers runs list' for the failed run`);
    return false;
  }
  console.log(`  PASS: row ${row.id}`);
  console.log(`        ${row.url}`);
  return true;
}

const selected = process.argv[2];
if (selected && !cases[selected]) {
  console.error(`Unknown case "${selected}". Known: ${Object.keys(cases).join(", ")}`);
  process.exit(1);
}
const runs = selected ? [[selected, cases[selected]]] : Object.entries(cases);

let allOk = true;
for (const [name, c] of runs) {
  const ok = await run(name, c);
  allOk = allOk && ok;
}

console.log(`\n${allOk ? "ALL PASS" : "FAILURES — see above"}`);
process.exit(allOk ? 0 : 1);
