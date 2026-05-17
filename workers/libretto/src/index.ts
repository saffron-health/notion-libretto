import { WebhookVerificationError, Worker } from "@notionhq/workers";
import { j } from "@notionhq/workers/schema-builder";
import { createHmac, timingSafeEqual } from "node:crypto";

import { callLibretto, type JsonObject, type JsonValue } from "./libretto.js";

const worker = new Worker();
export default worker;

const BUILD_READY_STATUSES = new Set(["ready"]);
const BUILD_FAILED_STATUSES = new Set(["failed", "error", "cancelled", "canceled"]);
const JOB_DONE_STATUSES = new Set(["completed", "complete", "succeeded", "success"]);
const JOB_FAILED_STATUSES = new Set(["failed", "error", "cancelled", "canceled"]);

type SchemaProperty = { type: string; [key: string]: unknown };
type Schema = Record<string, SchemaProperty>;
// The Workers SDK exposes a Notion client, but its generated type is not
// currently exported in a reusable form.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type NotionClient = any;

worker.tool("buildWorkflow", {
  title: "Build Browser Workflow",
  description:
    "Start building and deploying a Libretto browser workflow. Returns immediately with a build ID; use checkBuild to monitor deployment status. Before calling this tool, create or select the result database and add the properties the workflow should populate. If the user indicates the workflow needs a login or other stored secret, pass the credential ID they specify via credentialId so Libretto bakes the credential reference into the workflow definition.",
  schema: j.object({
    databaseUrl: j
      .string()
      .describe("The Notion database URL or database ID where workflow results should be written. The database must already exist and contain the properties the workflow should populate."),
    initialUrl: j
      .string()
      .describe("The URL where Libretto should start the browser workflow."),
    prompt: j
      .string()
      .describe("The browser workflow instructions Libretto should build. The worker appends the expected output row shape from the target Notion database."),
    credentialId: j
      .string()
      .nullable()
      .describe("Optional Libretto credential ID to attach to the build. Only set this when the user explicitly indicates a credential should be used (e.g. they provide an ID or ask the workflow to log in with stored secrets). Use null otherwise."),
  }),
  execute: async ({ databaseUrl, initialUrl, prompt, credentialId }, { notion }) => {
    const databaseId = extractNotionDatabaseId(databaseUrl);
    const params = { database_id: databaseId };
    const outputInstruction = await buildDatabaseOutputInstruction(
      notion,
      databaseId,
    );
    const build = await callLibretto("/v1/workflows/build", {
      descriptions: [buildPrompt(prompt, outputInstruction)],
      initial_url: initialUrl,
      params,
      ...(credentialId ? { credential_id: credentialId } : {}),
    });
    const buildId = getRequiredString(build, "build_id");

    return {
      build,
      build_id: buildId,
      run: null,
      schedule: null,
      message:
        "Workflow build/deployment has started. Use checkBuild with this build_id until it returns a workflow_name, then use runWorkflow to create a job or setSchedule to create, update, or delete a recurring schedule.",
    };
  },
});

worker.tool("editWorkflow", {
  title: "Edit Browser Workflow",
  description:
    "Start editing an existing deployed Libretto browser workflow. Returns immediately with a build ID; use checkBuild to monitor the edit/deployment status. The edit keeps the same workflow name, so future runWorkflow or setSchedule calls use the existing workflow name after checkBuild returns ready.",
  schema: j.object({
    workflow: j
      .string()
      .describe("The existing deployed Libretto workflow name to edit."),
    databaseUrl: j
      .string()
      .describe("The Notion database URL or database ID where workflow results should continue to be written."),
    initialUrl: j
      .string()
      .nullable()
      .describe("Optional URL where Libretto should start the edit verification. Use null if the existing workflow should decide where to start."),
    instruction: j
      .string()
      .describe("The requested change to make to the existing browser workflow."),
  }),
  execute: async ({ workflow, databaseUrl, initialUrl, instruction }, { notion }) => {
    const databaseId = extractNotionDatabaseId(databaseUrl);
    const outputInstruction = await buildDatabaseOutputInstruction(
      notion,
      databaseId,
    );
    const edit = await callLibretto("/v1/workflows/edit", {
      workflow,
      instruction: buildEditInstruction(instruction, outputInstruction),
      ...(initialUrl ? { initial_url: initialUrl } : {}),
      params: { database_id: databaseId },
    });
    const buildId = getRequiredString(edit, "build_id");

    return {
      edit,
      build_id: buildId,
      workflow,
      database_id: databaseId,
      message:
        "Workflow edit/deployment has started. Use checkBuild with this build_id until it returns ready; the edited workflow keeps the same workflow name for runWorkflow or setSchedule.",
    };
  },
});

worker.tool("checkBuild", {
  title: "Check Browser Workflow Build",
  description:
    "Check the status of a Libretto browser workflow build by build ID. Returns the build status, deployed workflow name when ready, and attempted_steps describing what the builder has tried so far.",
  schema: j.object({
    buildId: j.string().describe("The Libretto workflow build ID."),
  }),
  hints: { readOnlyHint: true },
  execute: async ({ buildId }) => {
    const build = await callLibretto("/v1/workflows/buildStatus", {
      build_id: buildId,
    });

    return formatBuildStatus(build, buildId);
  },
});

worker.tool("runWorkflow", {
  title: "Run Libretto Workflow",
  description:
    "Create a one-off job for a deployed Libretto browser workflow. The workflow returns JSON results to Libretto; if callback env vars are configured, Libretto posts completion to this worker's webhook, which writes rows to Notion.",
  schema: j.object({
    workflow: j.string().describe("The deployed Libretto workflow name."),
    databaseUrl: j
      .string()
      .describe("The Notion database URL or database ID where workflow results should be written."),
  }),
  execute: async ({ workflow, databaseUrl }) => {
    const databaseId = extractNotionDatabaseId(databaseUrl);
    const params = { database_id: databaseId };
    const callbackOptions = getCallbackOptions();
    const run = await createJob(workflow, params, callbackOptions);
    const jobId = getRequiredString(run, "job_id");
    const callbackEnabled = Object.keys(callbackOptions).length > 0;

    return {
      run,
      job_id: jobId,
      database_id: databaseId,
      callback_enabled: callbackEnabled,
      message:
        callbackEnabled
          ? "Libretto job has started with webhook delivery enabled. The workflow should return JSON rows; Libretto will call this worker's webhook, and the worker will write rows to Notion. Use checkRun only to monitor status."
          : "Libretto job has started without webhook delivery because callback env vars are not configured. Use checkRun to monitor status; results will be returned but not automatically inserted into Notion.",
    };
  },
});

worker.tool("checkRun", {
  title: "Check Libretto Workflow Run",
  description:
    "Check a Libretto browser workflow job by job ID. This is read-only: completed jobs return their JSON result, and Notion insertion is handled by the worker webhook callback when callback delivery is enabled.",
  schema: j.object({
    jobId: j.string().describe("The Libretto job ID returned by runWorkflow."),
    databaseUrl: j
      .string()
      .describe("The Notion database URL or database ID where workflow results should be written."),
  }),
  execute: async ({ jobId, databaseUrl }, { notion }) => {
    const databaseId = extractNotionDatabaseId(databaseUrl);
    void notion;
    const job = await callLibretto("/v1/jobs/get", { id: jobId });

    if (isJobFailed(job)) {
      throw new Error(`Libretto job ${jobId} failed: ${JSON.stringify(job)}`);
    }

    if (!isJobDone(job)) {
      return {
        job,
        job_id: jobId,
        database_id: databaseId,
        result_rows: 0,
        result: null,
        message:
          "Libretto job is still running. Call checkRun again with this job_id.",
      };
    }

    const result = isPlainObject(job) ? job.result : undefined;
    const rows = resultRows(result);

    return {
      job,
      job_id: jobId,
      database_id: databaseId,
      result_rows: rows.length,
      result: result ?? null,
      message:
        "Libretto job completed. checkRun is read-only; if webhook delivery was enabled for this job, the worker webhook handles inserting rows into Notion.",
    };
  },
});

worker.tool("setSchedule", {
  title: "Set Libretto Workflow Schedule",
  description:
    "Create, update, or delete a recurring schedule for a deployed Libretto browser workflow. Use create only after checkBuild has returned a workflow_name. Use listSchedules first when you need a schedule ID to update or delete.",
  schema: j.object({
    mode: j
      .enum("create", "update", "delete")
      .describe("Whether to create a new schedule, update an existing schedule, or delete an existing schedule."),
    scheduleId: j
      .string()
      .nullable()
      .describe("The schedule ID to update or delete. Use null when mode is create."),
    workflow: j
      .string()
      .nullable()
      .describe("The deployed Libretto workflow name. Required when mode is create; ignored for update/delete."),
    databaseUrl: j
      .string()
      .nullable()
      .describe("The Notion database URL or database ID to include in scheduled job params. Required for create; optional for update; use null to leave params unchanged when updating."),
    cron: j
      .string()
      .nullable()
      .describe("5-field cron expression for recurring Libretto runs. Required for create; optional for update; use null to leave unchanged when updating."),
    timezone: j
      .string()
      .nullable()
      .describe("IANA timezone for the cron expression, such as UTC or America/Los_Angeles. Use null to default to UTC on create or leave unchanged on update."),
    enabled: j
      .boolean()
      .nullable()
      .describe("Whether the schedule should be enabled. Use null to default to true on create or leave unchanged on update."),
  }),
  execute: async ({
    mode,
    scheduleId,
    workflow,
    databaseUrl,
    cron,
    timezone,
    enabled,
  }) => {
    if (mode === "delete") {
      if (!scheduleId) {
        throw new Error("scheduleId is required when mode is delete");
      }

      const deleted = await callLibretto("/v1/schedules/delete", {
        id: scheduleId,
      });

      return {
        deleted,
        schedule_id: scheduleId,
        message: `Schedule ${scheduleId} deleted.`,
      };
    }

    if (mode === "update") {
      if (!scheduleId) {
        throw new Error("scheduleId is required when mode is update");
      }

      const patch: JsonObject = { id: scheduleId };
      if (databaseUrl) {
        patch.params = { database_id: extractNotionDatabaseId(databaseUrl) };
      }
      if (cron) patch.cron_expr = cron;
      if (timezone) patch.timezone = timezone;
      if (enabled !== null) patch.enabled = enabled;

      const updated = await callLibretto("/v1/schedules/update", patch);

      return {
        updated,
        schedule_id: scheduleId,
        message: `Schedule ${scheduleId} updated.`,
      };
    }

    if (!workflow) {
      throw new Error("workflow is required when mode is create");
    }
    if (!databaseUrl) {
      throw new Error("databaseUrl is required when mode is create");
    }
    if (!cron) {
      throw new Error("cron is required when mode is create");
    }

    const databaseId = extractNotionDatabaseId(databaseUrl);
    const callbackOptions = getCallbackOptions();
    const created = await callLibretto("/v1/schedules/create", {
      workflow,
      params: { database_id: databaseId },
      cron_expr: cron,
      timezone: timezone ?? "UTC",
      enabled: enabled ?? true,
      ...callbackOptions,
    });

    return {
      created,
      database_id: databaseId,
      callback_enabled: Object.keys(callbackOptions).length > 0,
      message:
        Object.keys(callbackOptions).length > 0
          ? "Schedule created with callback delivery enabled. Use listSchedules to find the schedule ID before future updates or deletion."
          : "Schedule created without callback delivery. Set callback env vars if scheduled runs should write results into Notion automatically.",
    };
  },
});

worker.tool("listSchedules", {
  title: "List Libretto Workflow Schedules",
  description:
    "List recurring Libretto workflow schedules, optionally filtered by workflow name or enabled state. Use this to find schedule IDs before calling setSchedule in update or delete mode.",
  hints: { readOnlyHint: true },
  schema: j.object({
    workflow: j
      .string()
      .nullable()
      .describe("Optional deployed workflow name to filter by. Use null to list schedules for all workflows."),
    enabled: j
      .boolean()
      .nullable()
      .describe("Optional enabled-state filter. Use null to include both enabled and disabled schedules."),
    limit: j
      .integer()
      .nullable()
      .describe("Optional maximum number of schedules to return. Use null for the Libretto default."),
  }),
  execute: async ({ workflow, enabled, limit }) => {
    const query: JsonObject = {};
    if (workflow) query.workflow = workflow;
    if (enabled !== null) query.enabled = enabled;
    if (limit !== null) query.limit = limit;

    return callLibretto("/v1/schedules/list", query);
  },
});

worker.tool("listWorkflows", {
  title: "List Libretto Workflows",
  description:
    "List every Libretto workflow available on the account, so the agent can pick one to invoke via runWorkflow. Returns deployed workflows plus any builds currently in progress. Each deployed workflow is enriched with `input_schema` and `output_schema` (JSON Schema) fetched from /v1/workflows/get; either may be null for legacy workflows built before Zod schemas were supported.",
  hints: { readOnlyHint: true },
  schema: j.object({}),
  execute: async () => {
    const list = await callLibretto("/v1/workflows/list", {});

    if (
      list === null ||
      typeof list !== "object" ||
      Array.isArray(list) ||
      !Array.isArray((list as { deployed_workflows?: unknown }).deployed_workflows)
    ) {
      return list;
    }

    const deployed = (list as { deployed_workflows: JsonValue[] }).deployed_workflows;

    const enriched = await Promise.all(
      deployed.map(async (entry) => {
        if (!entry || typeof entry !== "object" || Array.isArray(entry)) {
          return entry;
        }
        const name = (entry as { name?: unknown }).name;
        if (typeof name !== "string" || name.length === 0) {
          return entry;
        }
        try {
          const detail = await callLibretto("/v1/workflows/get", { workflow: name });
          if (detail && typeof detail === "object" && !Array.isArray(detail)) {
            const d = detail as { input_schema?: JsonValue; output_schema?: JsonValue };
            return {
              ...(entry as JsonObject),
              input_schema: d.input_schema ?? null,
              output_schema: d.output_schema ?? null,
            };
          }
          return entry;
        } catch {
          return {
            ...(entry as JsonObject),
            input_schema: null,
            output_schema: null,
          };
        }
      }),
    );

    return {
      ...(list as JsonObject),
      deployed_workflows: enriched,
    };
  },
});

worker.tool("deleteWorkflow", {
  title: "Delete Libretto Workflow",
  description:
    "Permanently delete a Libretto workflow by name. Destructive and irreversible — the workflow definition will no longer be available to run via runWorkflow. Confirm the workflow name with the user before calling.",
  schema: j.object({
    workflow: j
      .string()
      .describe("The Libretto workflow name (slug or identifier) to delete."),
  }),
  execute: async ({ workflow }) =>
    callLibretto("/v1/workflows/delete", { workflow }),
});

worker.webhook("insertIntoDatabase", {
  title: "Insert Into Notion Database",
  description:
    "Receives { data, database_id } and creates a new page in the given Notion database, mapping each field in data onto whatever properties the database exposes.",
  execute: async (events, { notion }) => {
    for (const event of events) {
      const payload = event.body as Record<string, unknown>;
      if (isLibrettoCallback(payload)) {
        await handleLibrettoCallback(payload, notion, event.headers);
        continue;
      }

      const secret = process.env.WEBHOOK_SHARED_SECRET;
      if (secret) {
        const provided = event.headers["x-webhook-secret"];
        if (provided !== secret) {
          throw new WebhookVerificationError("Invalid x-webhook-secret");
        }
      }

      const databaseId = payload.database_id;
      const data = payload.data;

      if (typeof databaseId !== "string" || databaseId.length === 0) {
        throw new Error("Missing or invalid `database_id` in payload");
      }
      if (!isPlainObject(data)) {
        throw new Error("Missing or invalid `data` in payload (must be a JSON object)");
      }

      await insertRow(notion, databaseId, data);
    }
  },
});

async function handleLibrettoCallback(
  payload: Record<string, unknown>,
  notion: NotionClient,
  headers: Record<string, string>,
) {
  const callbackSecret = getCallbackSecret();
  if (callbackSecret) {
    verifyLibrettoSignature(payload, headers, callbackSecret);
  }

  if (payload.event === "job.failed" || payload.status === "failed") {
    throw new Error(
      `Libretto job ${String(payload.job_id)} failed: ${JSON.stringify(
        payload.error ?? payload.mapped_stack ?? payload,
      )}`,
    );
  }

  const jobId = getRequiredString(payload, "job_id");
  const job = await callLibretto("/v1/jobs/get", { id: jobId });
  const jobObject = isPlainObject(job) ? job : {};
  const params = isPlainObject(jobObject.params) ? jobObject.params : {};
  const databaseId = params.database_id ?? payload.database_id;
  const result = payload.result ?? jobObject.result;

  if (typeof databaseId !== "string" || databaseId.length === 0) {
    throw new Error(`Libretto job ${jobId} did not include params.database_id`);
  }

  for (const row of resultRows(result)) {
    await insertRow(notion, databaseId, row);
  }
}

function isLibrettoCallback(payload: Record<string, unknown>) {
  return typeof payload.job_id === "string" && typeof payload.workflow === "string";
}

async function createJob(
  workflow: string,
  params: JsonObject,
  options: JsonObject = {},
) {
  return callLibretto("/v1/jobs/create", {
    workflow,
    params,
    ...options,
  });
}

function getCallbackOptions(): Record<string, string> {
  const callbackUrl =
    process.env.LIBRETTO_CALLBACK_URL ??
    process.env.LIBRETTO_WEBHOOK_URL ??
    process.env.WEBHOOK_URL;
  if (!callbackUrl) return {};

  const callbackSecret = getCallbackSecret();
  if (!callbackSecret) {
    throw new Error(
      "LIBRETTO_CALLBACK_URL is configured but LIBRETTO_CALLBACK_SECRET is missing",
    );
  }

  return {
    callback_url: callbackUrl,
    callback_secret: callbackSecret,
  };
}

function getCallbackSecret() {
  return process.env.LIBRETTO_CALLBACK_SECRET ?? process.env.WEBHOOK_SHARED_SECRET;
}

async function buildDatabaseOutputInstruction(
  notion: NotionClient,
  databaseId: string,
) {
  const { schema } = await retrieveDataSource(notion, databaseId);
  const example = buildOutputExample(schema);

  return [
    "Output should be in this shape:",
    JSON.stringify(example, null, 2),
  ].join("\n");
}

async function retrieveDataSource(notion: NotionClient, databaseId: string) {
  const database = (await notion.databases.retrieve({
    database_id: databaseId,
  })) as unknown as { data_sources?: { id: string }[] };

  const dataSourceId = database.data_sources?.[0]?.id;
  if (!dataSourceId) {
    throw new Error(`Database ${databaseId} has no data sources`);
  }

  const dataSource = (await notion.dataSources.retrieve({
    data_source_id: dataSourceId,
  })) as { properties: Schema };

  return { id: dataSourceId, schema: dataSource.properties };
}

function buildOutputExample(schema: Schema): Record<string, unknown> {
  const example: Record<string, unknown> = {};
  for (const [name, property] of Object.entries(schema)) {
    const value = exampleValueForProperty(property);
    if (value !== undefined) {
      example[name] = value;
    }
  }
  return example;
}

function exampleValueForProperty(property: SchemaProperty) {
  switch (property.type) {
    case "title":
    case "rich_text":
      return "string";
    case "number":
      return 0;
    case "checkbox":
      return true;
    case "select":
    case "status":
      return "Option";
    case "multi_select":
      return ["Option"];
    case "date":
      return "2026-05-17";
    case "url":
      return "https://example.com";
    case "email":
      return "name@example.com";
    case "phone_number":
      return "+1 555 555 5555";
    default:
      return undefined;
  }
}

function buildPrompt(prompt: string, outputInstruction: string) {
  return [
    prompt,
    "",
    outputInstruction,
    "",
    "Return the scraped data as a flat JSON object or an array of flat JSON objects.",
    "Use keys that exactly match the target Notion database properties.",
    "Do not call Notion directly. Return the result data only; this worker's webhook receives the Libretto job callback and writes rows to Notion.",
  ].join("\n");
}

function buildEditInstruction(instruction: string, outputInstruction: string) {
  return [
    instruction,
    "",
    outputInstruction,
    "",
    "Keep the existing workflow name unchanged.",
    "Keep the workflow returning a flat JSON object or an array of flat JSON objects.",
    "Use keys that exactly match the target Notion database properties.",
    "Do not call Notion directly. Return the result data only; this worker's webhook receives the Libretto job callback and writes rows to Notion.",
  ].join("\n");
}

async function insertRow(
  notion: NotionClient,
  databaseId: string,
  data: Record<string, unknown>,
) {
  const dataSource = await retrieveDataSource(notion, databaseId);

  const properties = buildProperties(data, dataSource.schema);

  const created = await notion.pages.create({
    parent: { data_source_id: dataSource.id },
    properties,
  });

  console.log(
    `Inserted page ${("id" in created && created.id) || "?"} into database ${databaseId}`,
  );
}

function resultRows(result: unknown): Record<string, unknown>[] {
  if (Array.isArray(result)) {
    return result.filter(isPlainObject);
  }

  if (!isPlainObject(result)) {
    throw new Error("Libretto job result was not a JSON object or array");
  }

  if (Array.isArray(result.rows)) {
    return result.rows.filter(isPlainObject);
  }

  if (Array.isArray(result.items)) {
    return result.items.filter(isPlainObject);
  }

  if (isPlainObject(result.data)) {
    return [result.data];
  }

  return [result];
}

function verifyLibrettoSignature(
  payload: Record<string, unknown>,
  headers: Record<string, string>,
  secret: string,
) {
  const provided = headers["x-webhook-signature"];
  if (!provided) {
    throw new WebhookVerificationError("Missing x-webhook-signature");
  }

  const expected = createHmac("sha256", secret)
    .update(JSON.stringify(payload))
    .digest("hex");
  const signature = provided.includes("=") ? provided.split("=").at(-1)! : provided;
  const expectedBuffer = Buffer.from(expected, "hex");
  const actualBuffer = Buffer.from(signature, "hex");

  if (
    expectedBuffer.length !== actualBuffer.length ||
    !timingSafeEqual(expectedBuffer, actualBuffer)
  ) {
    throw new WebhookVerificationError("Invalid x-webhook-signature");
  }
}

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
    case "status":
      return { status: { name: asString(value) } };
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

function formatBuildStatus(build: JsonValue, fallbackBuildId: string) {
  const buildObject = isPlainObject(build) ? build : {};
  const buildId =
    typeof buildObject.build_id === "string" && buildObject.build_id.length > 0
      ? buildObject.build_id
      : fallbackBuildId;
  const status =
    typeof buildObject.status === "string" && buildObject.status.length > 0
      ? buildObject.status
      : "unknown";
  const workflowName =
    typeof buildObject.workflow_name === "string" &&
    buildObject.workflow_name.length > 0
      ? buildObject.workflow_name
      : null;
  const deploymentId =
    typeof buildObject.deployment_id === "string" &&
    buildObject.deployment_id.length > 0
      ? buildObject.deployment_id
      : null;
  const attemptedSteps = Array.isArray(buildObject.attempted_steps)
    ? buildObject.attempted_steps.filter(
        (step): step is string => typeof step === "string",
      )
    : [];

  return {
    build,
    build_id: buildId,
    status,
    workflow_name: workflowName,
    deployment_id: deploymentId,
    summary:
      typeof buildObject.summary === "string" ? buildObject.summary : null,
    error: typeof buildObject.error === "string" ? buildObject.error : null,
    details:
      typeof buildObject.details === "string" ? buildObject.details : null,
    attempted_steps: attemptedSteps,
    message: buildStatusMessage(status, workflowName, attemptedSteps),
  };
}

function buildStatusMessage(
  status: string,
  workflowName: string | null,
  attemptedSteps: string[],
) {
  const lowerStatus = status.toLowerCase();
  const stepsSummary =
    attemptedSteps.length > 0
      ? ` attempted_steps contains ${attemptedSteps.length} builder step(s) for debugging.`
      : "";

  if (BUILD_READY_STATUSES.has(lowerStatus)) {
    return `Workflow build is ready. Use workflow_name "${workflowName}" with runWorkflow or setSchedule.${stepsSummary}`;
  }

  if (BUILD_FAILED_STATUSES.has(lowerStatus)) {
    return `Workflow build failed. Use error, details, and attempted_steps to explain the root cause.${stepsSummary}`;
  }

  return `Workflow build status is "${status}". Call checkBuild again later; attempted_steps shows current builder progress.${stepsSummary}`;
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

function isJobDone(value: unknown) {
  if (!hasString(value, "status")) {
    return false;
  }

  return JOB_DONE_STATUSES.has(value.status!.toLowerCase());
}

function isJobFailed(value: unknown) {
  if (!hasString(value, "status")) {
    return false;
  }

  return JOB_FAILED_STATUSES.has(value.status!.toLowerCase());
}
