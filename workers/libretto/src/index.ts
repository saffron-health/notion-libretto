import { WebhookVerificationError, Worker } from "@notionhq/workers";
import { j } from "@notionhq/workers/schema-builder";

import { callLibretto, parseJsonObject } from "./libretto.js";

const worker = new Worker();
export default worker;

const BUILD_POLL_ATTEMPTS = 8;
const BUILD_POLL_INTERVAL_MS = 1_500;

type SchemaProperty = { type: string; [key: string]: unknown };
type Schema = Record<string, SchemaProperty>;

worker.tool("buildWorkflow", {
  title: "Build Browser Workflow",
  description:
    "Build a Libretto browser workflow, wait for the deployed workflow, run it once, and optionally schedule recurring runs. Before calling this tool, create or select the result database, add the properties the workflow should populate, and include the expected row shape in the prompt.",
  schema: j.object({
    databaseUrl: j
      .string()
      .describe("The Notion database URL or database ID where workflow results should be written. The database must already exist and contain the properties the workflow should populate."),
    initialUrl: j
      .string()
      .describe("The URL where Libretto should start the browser workflow."),
    prompt: j
      .string()
      .describe("The browser workflow instructions Libretto should build. Include the fields/properties to extract and the expected output row shape that matches the target Notion database."),
    schedule: j
      .string()
      .describe("Cron expression for recurring Libretto runs, or an empty string for no schedule."),
  }),
  execute: async ({ databaseUrl, initialUrl, prompt, schedule }) => {
    const databaseId = extractNotionDatabaseId(databaseUrl);
    const params = { database_id: databaseId };
    const build = await callLibretto("/v1/workflows/build", {
      descriptions: [prompt],
      initial_url: initialUrl,
      params,
    });
    const buildId = getRequiredString(build, "build_id");
    const buildStatus = await waitForBuild(buildId);

    if (!hasString(buildStatus, "workflow_name")) {
      return {
        build,
        build_status: buildStatus,
        run: null,
        schedule: null,
        message:
          "Workflow build is still in progress. Use checkBuild with the build_id to monitor status.",
      };
    }

    const workflow = getRequiredString(buildStatus, "workflow_name");
    const run = await callLibretto("/v1/jobs/create", {
      workflow,
      params,
      ...getLibrettoCallbackConfig(),
    });
    const cronExpr = schedule.trim();
    const scheduled = cronExpr
      ? await callLibretto("/v1/schedules/create", {
          workflow,
          params,
          cron_expr: cronExpr,
          ...getLibrettoCallbackConfig(),
        })
      : null;

    return {
      build,
      build_status: buildStatus,
      run,
      schedule: scheduled,
    };
  },
});

worker.tool("checkBuild", {
  title: "Check Browser Workflow Build",
  description:
    "Check the status of a Libretto browser workflow build by build ID. Use this when buildWorkflow returns a pending or in-progress build instead of a completed workflow.",
  schema: j.object({
    buildId: j.string().describe("The Libretto workflow build ID."),
  }),
  hints: { readOnlyHint: true },
  execute: async ({ buildId }) =>
    callLibretto("/v1/workflows/buildStatus", { build_id: buildId }),
});

worker.tool("runWorkflow", {
  title: "Run Libretto Workflow",
  description:
    "Start a deployed Libretto browser workflow job and route its results back to a Notion database.",
  schema: j.object({
    workflow: j.string().describe("The deployed Libretto workflow name."),
    databaseUrl: j
      .string()
      .describe("The Notion database URL or database ID where workflow results should be written."),
    paramsJson: j
      .string()
      .nullable()
      .describe("Optional JSON object parameters to pass to the workflow, or null."),
    nonce: j
      .string()
      .nullable()
      .describe("Optional idempotency nonce, or null."),
    timeoutSeconds: j
      .integer()
      .nullable()
      .describe("Optional timeout in seconds, or null for Libretto default."),
  }),
  execute: async ({ workflow, databaseUrl, paramsJson, nonce, timeoutSeconds }) => {
    const databaseId = extractNotionDatabaseId(databaseUrl);
    const params = paramsJson ? parseJsonObject(paramsJson, "paramsJson") : {};

    return callLibretto("/v1/jobs/create", {
      workflow,
      params: {
        ...params,
        database_id: databaseId,
      },
      ...getLibrettoCallbackConfig(),
      ...(nonce ? { nonce } : {}),
      ...(timeoutSeconds ? { timeout_seconds: timeoutSeconds } : {}),
    });
  },
});

worker.webhook("insertIntoDatabase", {
  title: "Insert Into Notion Database",
  description:
    "Receives { data, database_id } and creates a new page in the given Notion database, mapping each field in data onto whatever properties the database exposes.",
  execute: async (events, { notion }) => {
    const secret = process.env.WEBHOOK_SHARED_SECRET;

    for (const event of events) {
      if (secret) {
        const provided = event.headers["x-webhook-secret"];
        if (provided !== secret) {
          throw new WebhookVerificationError("Invalid x-webhook-secret");
        }
      }

      const { databaseId, data } = parseInsertPayload(event.body);

      if (!isPlainObject(data)) {
        throw new Error("Missing or invalid `data` in payload (must be a JSON object)");
      }

      // Notion's 2025-09-03 API split databases into databases + data sources.
      // Property schema lives on the data source, not the database.
      const database = (await notion.databases.retrieve({
        database_id: databaseId,
      })) as unknown as { data_sources?: { id: string }[] };

      const dataSourceId = database.data_sources?.[0]?.id;
      if (!dataSourceId) {
        throw new Error(`Database ${databaseId} has no data sources`);
      }

      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const dataSource = (await (notion as any).dataSources.retrieve({
        data_source_id: dataSourceId,
      })) as { properties: Schema };

      const properties = buildProperties(data, dataSource.properties);

      const created = await notion.pages.create({
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        parent: { data_source_id: dataSourceId } as any,
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        properties: properties as any,
      });

      console.log(
        `Inserted page ${("id" in created && created.id) || "?"} into database ${databaseId}`,
      );
    }
  },
});

function buildProperties(
  data: Record<string, unknown>,
  schema: Schema,
): Record<string, unknown> {
  const lookup = new Map<string, string>();
  for (const name of Object.keys(schema)) {
    lookup.set(name, name);
    lookup.set(name.toLowerCase(), name);
  }

  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(data)) {
    if (value === null || value === undefined) continue;

    const propName = lookup.get(key) ?? lookup.get(key.toLowerCase());
    if (!propName) {
      console.warn(`No property named "${key}" in database schema; skipping`);
      continue;
    }

    const prop = schema[propName];
    if (!prop) continue;

    const built = buildPropertyValue(prop.type, value);
    if (built === undefined) {
      console.warn(
        `Cannot encode value for "${key}" (type ${prop.type}); skipping`,
      );
      continue;
    }
    out[propName] = built;
  }
  return out;
}

function buildPropertyValue(type: string, value: unknown): unknown | undefined {
  switch (type) {
    case "title":
      return { title: [{ type: "text", text: { content: asString(value) } }] };
    case "rich_text":
      return {
        rich_text: [{ type: "text", text: { content: asString(value) } }],
      };
    case "number": {
      const n = typeof value === "number" ? value : Number(value);
      return Number.isFinite(n) ? { number: n } : undefined;
    }
    case "checkbox":
      return { checkbox: Boolean(value) };
    case "select":
      return { select: { name: asString(value) } };
    case "multi_select": {
      const names = Array.isArray(value)
        ? value.map(asString)
        : typeof value === "string"
          ? value.split(",").map((s) => s.trim()).filter(Boolean)
          : [asString(value)];
      return { multi_select: names.map((name) => ({ name })) };
    }
    case "date": {
      if (typeof value === "string") return { date: { start: value } };
      if (isPlainObject(value) && typeof value.start === "string") {
        return { date: value };
      }
      return undefined;
    }
    case "url":
      return { url: asString(value) };
    case "email":
      return { email: asString(value) };
    case "phone_number":
      return { phone_number: asString(value) };
    default:
      return undefined;
  }
}

function asString(value: unknown): string {
  return typeof value === "string" ? value : JSON.stringify(value);
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function getLibrettoCallbackConfig(): {
  callback_url: string;
  callback_secret: string;
} {
  const callbackUrl = process.env.LIBRETTO_CALLBACK_URL;
  const callbackSecret = process.env.LIBRETTO_CALLBACK_SECRET;

  if (!callbackUrl) {
    throw new Error("LIBRETTO_CALLBACK_URL is not configured");
  }
  if (!callbackSecret) {
    throw new Error("LIBRETTO_CALLBACK_SECRET is not configured");
  }

  return {
    callback_url: callbackUrl,
    callback_secret: callbackSecret,
  };
}

function parseInsertPayload(body: unknown): {
  databaseId: string;
  data: unknown;
} {
  if (!isPlainObject(body)) {
    throw new Error("Webhook payload must be a JSON object");
  }

  const databaseId = body.database_id;
  const directData = body.data;
  const resultData = isPlainObject(body.result) ? body.result.data : undefined;
  const result = isPlainObject(body.result) ? body.result : undefined;
  const data = directData ?? resultData ?? result;

  if (typeof databaseId !== "string" || databaseId.length === 0) {
    throw new Error("Missing or invalid `database_id` in payload");
  }

  return { databaseId, data };
}

function extractNotionDatabaseId(value: string): string {
  const match = value.match(/[0-9a-fA-F]{32}/);
  if (!match) {
    throw new Error(
      "Expected a Notion database URL or database ID containing 32 hexadecimal characters",
    );
  }

  const raw = match[0].toLowerCase();
  return [
    raw.slice(0, 8),
    raw.slice(8, 12),
    raw.slice(12, 16),
    raw.slice(16, 20),
    raw.slice(20),
  ].join("-");
}

async function waitForBuild(buildId: string) {
  let latest = await callLibretto("/v1/workflows/buildStatus", {
    build_id: buildId,
  });

  for (let attempt = 0; attempt < BUILD_POLL_ATTEMPTS; attempt += 1) {
    if (hasString(latest, "error")) {
      throw new Error(`Libretto workflow build failed: ${latest.error}`);
    }

    if (hasString(latest, "workflow_name")) {
      return latest;
    }

    await sleep(BUILD_POLL_INTERVAL_MS);
    latest = await callLibretto("/v1/workflows/buildStatus", {
      build_id: buildId,
    });
  }

  return latest;
}

function getRequiredString(value: unknown, key: string): string {
  if (!hasString(value, key)) {
    throw new Error(`Libretto response did not include ${key}`);
  }
  return value[key]!;
}

function hasString(value: unknown, key: string): value is Record<string, string> {
  if (value === null || typeof value !== "object") {
    return false;
  }

  const candidate = (value as Record<string, unknown>)[key];
  return typeof candidate === "string" && candidate.length > 0;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}
