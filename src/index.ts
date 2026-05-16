import { WebhookVerificationError, Worker } from "@notionhq/workers";
import { j } from "@notionhq/workers/schema-builder";

import { callLibretto, parseJsonObject } from "./libretto.js";
import { verifyHmacSha256Signature } from "./signature.js";

const worker = new Worker();
export default worker;

worker.tool("buildWorkflow", {
  title: "Build Libretto Workflow",
  description:
    "Build a Libretto browser automation workflow from a URL, goal, and structured output example. Use this when the user wants to create a new browser-based data extraction or action workflow.",
  schema: j.object({
    initialUrl: j.string().describe("The URL where Libretto should start."),
    goal: j
      .string()
      .describe("The browser task Libretto should automate."),
    outputSchemaExampleJson: j
      .string()
      .describe("A JSON object example of the desired workflow output."),
  }),
  execute: async ({ initialUrl, goal, outputSchemaExampleJson }) => {
    const params = parseJsonObject(
      outputSchemaExampleJson,
      "outputSchemaExampleJson",
    );

    return callLibretto("/v1/workflows/build", {
      descriptions: [goal],
      initial_url: initialUrl,
      params,
    });
  },
});

worker.tool("checkBuild", {
  title: "Check Libretto Build",
  description:
    "Check the status of a Libretto AI workflow build. Use this after buildWorkflow returns a build ID.",
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
    "Start a deployed Libretto workflow job. Use this when the user wants to run an existing browser workflow.",
  schema: j.object({
    workflow: j.string().describe("The deployed Libretto workflow name."),
    paramsJson: j
      .string()
      .describe("JSON object parameters to pass to the workflow."),
    nonce: j
      .string()
      .nullable()
      .describe("Optional idempotency nonce, or null."),
    timeoutSeconds: j
      .integer()
      .nullable()
      .describe("Optional timeout in seconds, or null for Libretto default."),
  }),
  execute: async ({ workflow, paramsJson, nonce, timeoutSeconds }) => {
    const params = parseJsonObject(paramsJson, "paramsJson");

    return callLibretto("/v1/jobs/create", {
      workflow,
      params,
      ...(nonce ? { nonce } : {}),
      ...(timeoutSeconds ? { timeout_seconds: timeoutSeconds } : {}),
    });
  },
});

worker.tool("getJob", {
  title: "Get Libretto Job",
  description:
    "Fetch a Libretto workflow job result by job ID. Use this to inspect completed or failed workflow runs.",
  schema: j.object({
    jobId: j.string().describe("The Libretto job ID."),
  }),
  hints: { readOnlyHint: true },
  execute: async ({ jobId }) => callLibretto("/v1/jobs/get", { id: jobId }),
});

worker.tool("debugJob", {
  title: "Debug Libretto Job",
  description:
    "Fetch Libretto's debug report for a failed job, including available recording, screenshot, and handoff details.",
  schema: j.object({
    jobId: j.string().describe("The Libretto job ID to debug."),
  }),
  hints: { readOnlyHint: true },
  execute: async ({ jobId }) =>
    callLibretto("/v1/jobs/debugReport", { id: jobId }),
});

worker.webhook("onLibrettoJobResult", {
  title: "Libretto Job Result",
  description:
    "Receives Libretto job.completed and job.failed events and optionally records them in a Notion database.",
  execute: async (events, { notion }) => {
    const secret = process.env.LIBRETTO_WEBHOOK_SECRET;
    if (!secret) {
      throw new WebhookVerificationError(
        "LIBRETTO_WEBHOOK_SECRET is not configured",
      );
    }

    for (const event of events) {
      const verified = verifyHmacSha256Signature({
        rawBody: event.rawBody,
        headers: event.headers,
        secret,
        headerName: "x-webhook-signature",
      });

      if (!verified) {
        throw new WebhookVerificationError("Invalid Libretto signature");
      }

      const databaseId = process.env.LIBRETTO_JOB_EVENTS_DATABASE_ID;
      if (!databaseId) {
        console.log("Verified Libretto event", event.body);
        continue;
      }

      const body = event.body;
      const jobId = typeof body.job_id === "string" ? body.job_id : "unknown";
      const workflow =
        typeof body.workflow === "string" ? body.workflow : "unknown";
      const status = typeof body.status === "string" ? body.status : "unknown";

      await notion.pages.create({
        parent: { database_id: databaseId },
        properties: {
          Name: {
            title: [{ text: { content: `${workflow} ${status}` } }],
          },
          "Job ID": {
            rich_text: [{ text: { content: jobId } }],
          },
          Workflow: {
            rich_text: [{ text: { content: workflow } }],
          },
          Status: {
            select: { name: status },
          },
        },
      });
    }
  },
});
