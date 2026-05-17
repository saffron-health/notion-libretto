#!/usr/bin/env node
// Push specific env vars from the repo .env up to the worker ID set in
// the repo .env, using `ntn workers env set`. Run via `npm run env:push`.

import { spawn } from "node:child_process";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const workspaceId = process.env.WORKSPACE_ID;
const workerId = process.env.WORKER_ID;
const environment = process.env.WORKER_ENVIRONMENT ?? "prod";
if (!workspaceId || !workerId) {
  console.error("Missing WORKSPACE_ID or WORKER_ID");
  process.exit(1);
}

const DEFAULT_PUSH_KEYS = [
  "LIBRETTO_API_KEY",
  "NOTION_API_TOKEN",
  "WEBHOOK_URL",
];
const PUSH_KEYS =
  process.argv.length > 2 ? process.argv.slice(2) : DEFAULT_PUSH_KEYS;

const pairs = PUSH_KEYS.flatMap((k) => {
  const v = process.env[k];
  if (!v) {
    console.warn(`(skipping ${k}: not set in local .env)`);
    return [];
  }
  return [`${k}=${v}`];
});

if (pairs.length === 0) {
  console.error("Nothing to push");
  process.exit(1);
}

const dir = mkdtempSync(join(tmpdir(), "ntn-workers-"));
const configPath = join(dir, "workers.json");
writeFileSync(
  configPath,
  JSON.stringify({ version: "1", environment, workspaceId, workerId }),
);

console.log(`Pushing ${pairs.map((p) => p.split("=")[0]).join(", ")} to worker ${workerId}`);
// Strip env vars that `ntn` itself reads for auth — they belong to the
// worker, not to our local ntn login session.
const { NOTION_API_TOKEN: _t, ...cleanEnv } = process.env;
const child = spawn(
  "ntn",
  ["workers", "env", "set", "--workers-config-file", configPath, ...pairs],
  { stdio: "inherit", env: cleanEnv },
);
child.on("exit", (code) => {
  rmSync(dir, { recursive: true, force: true });
  process.exit(code ?? 1);
});
