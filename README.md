# notion-libretto

Notion Worker scaffold that lets a Notion Custom Agent build, run, inspect, and receive callbacks from Libretto Cloud browser workflows.

## What This Worker Provides

- `buildWorkflow`: asks Libretto Cloud to generate a browser workflow from a URL, goal, and desired output shape.
- `checkBuild`: checks the status of a Libretto AI workflow build.
- `runWorkflow`: starts a deployed Libretto workflow job.
- `getJob`: fetches a Libretto job result.
- `debugJob`: fetches a Libretto debug report for a failed run.
- `onLibrettoJobResult`: verifies Libretto job webhooks and optionally records events in a Notion database.

## Requirements

- Node.js 20+
- Notion CLI: `curl -fsSL https://ntn.dev | bash`
- A Libretto Cloud API key
- A Notion workspace with Workers beta access

## Setup

Install dependencies:

```bash
npm install
```

Log in to Notion:

```bash
ntn login
```

Set Worker secrets:

```bash
ntn workers env set LIBRETTO_API_KEY=...
ntn workers env set LIBRETTO_WEBHOOK_SECRET=...
```

If the webhook should write job events into a Notion database, also set:

```bash
ntn workers env set NOTION_API_TOKEN=...
ntn workers env set LIBRETTO_JOB_EVENTS_DATABASE_ID=...
```

The target database should have these properties:

- `Name`: title
- `Job ID`: rich text
- `Workflow`: rich text
- `Status`: select

## Local Checks

```bash
npm run type-check
```

Run a tool locally:

```bash
ntn workers exec buildWorkflow --local -d '{
  "initialUrl": "https://example.com",
  "goal": "Extract the first 10 listings with title, URL, and price.",
  "outputSchemaExampleJson": "{\"listings\":[{\"title\":\"\",\"url\":\"\",\"price\":\"\"}]}"
}'
```

## Deploy

```bash
ntn workers deploy
```

List webhook URLs after deploy:

```bash
ntn workers webhooks list
```

Use the `onLibrettoJobResult` URL as either:

- a Libretto per-job `callback_url` when creating a job, or
- a stored Libretto tenant webhook via `POST /v1/webhooks/create`.

## How It Fits Together

The Notion Worker is the Notion-native control plane. It exposes agent tools and webhooks inside Notion.

Libretto Cloud is the browser execution plane. It builds and runs browser workflows, then returns structured results, recordings, and debug reports.

The intended loop is:

1. A Notion user writes a workflow spec in a page.
2. A Notion Custom Agent calls `buildWorkflow`.
3. The user reviews the build result and calls `runWorkflow`.
4. Libretto runs the browser workflow.
5. `onLibrettoJobResult` receives the signed completion event.
6. The Worker writes status/results back into Notion.
