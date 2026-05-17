#!/usr/bin/env node
// Deploy this worker to the worker ID + workspace ID set in the repo .env.
// Run via `npm run deploy` (which sources .env). The script writes a
// temporary workers.json so the bundled `workers.json` checked into the
// repo isn't disturbed.

import { spawn } from "node:child_process";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const workspaceId = process.env.WORKSPACE_ID;
const workerId = process.env.WORKER_ID;
const environment = process.env.WORKER_ENVIRONMENT ?? "prod";

if (!workspaceId || !workerId) {
  console.error(
    "Missing WORKSPACE_ID or WORKER_ID. Set them in the repo .env and rerun.",
  );
  process.exit(1);
}

const dir = mkdtempSync(join(tmpdir(), "ntn-workers-"));
const configPath = join(dir, "workers.json");
writeFileSync(
  configPath,
  JSON.stringify({ version: "1", environment, workspaceId, workerId }),
);

const args = ["workers", "deploy", "--workers-config-file", configPath, ...process.argv.slice(2)];
console.log(`Deploying worker ${workerId} (workspace ${workspaceId})`);
// Strip env vars that `ntn` itself reads for auth — they belong to the
// worker, not to our local ntn login session.
const { NOTION_API_TOKEN: _t, ...cleanEnv } = process.env;
const child = spawn("ntn", args, { stdio: "inherit", env: cleanEnv });
child.on("exit", (code) => {
  rmSync(dir, { recursive: true, force: true });
  process.exit(code ?? 1);
});
