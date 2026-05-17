# libretto

A Notion Worker that lets a Custom Agent build and run Libretto browser workflows, plus a webhook (`insertIntoDatabase`) that accepts an arbitrary flat JSON payload and writes it as a new page into any Notion database the worker has access to.

All `npm` and `ntn` commands below assume you are inside `workers/libretto/`.

## Agent tools

- `buildWorkflow`: asks Libretto Cloud to build a browser workflow, polls until a deployed workflow is available, runs it once, and optionally creates a recurring schedule.
- `checkBuild`: checks a Libretto AI workflow build status when a build needs manual follow-up.
- `runWorkflow`: starts a deployed Libretto workflow job and passes the target Notion database URL or ID in the job params.
- `listWorkflows`: returns every Libretto workflow on the account (deployed plus in-progress builds), so the agent can pick one before calling `runWorkflow`. Libretto's API does not expose per-workflow parameter schemas — names are the primary hint about what each one accepts.
- `deleteWorkflow`: permanently deletes a Libretto workflow by name. Destructive and irreversible; confirm the name with the user before invoking.

Before calling `buildWorkflow`, the Custom Agent should create or select the target database, add the properties the browser workflow should populate, and include the expected row shape in the prompt.

Example tool input:

```json
{
  "databaseUrl": "https://www.notion.so/3c9bab308c7c4808b9c122df75a8e48f",
  "initialUrl": "https://example.com",
  "prompt": "Build a browser workflow that extracts listings. Output each row with properties matching this Notion database shape: {\"Title\":\"Mid-century chair\",\"URL\":\"https://example.com/listing/123\",\"Price\":240}.",
  "schedule": ""
}
```

Use a cron expression for recurring runs:

```json
{
  "schedule": "0 */6 * * *"
}
```

## Payload shape

The webhook expects a POST with JSON of the form:

```json
{
  "database_id": "cdea7ded34f04440897458af4957e00f",
  "data": {
    "Title": "Mid-century chair",
    "URL": "https://example.com/listing/123",
    "Price": 240,
    "Location": "Brooklyn, NY",
    "Posted": "2026-05-15",
    "Category": "Furniture",
    "Tags": ["urgent", "cheap"],
    "Available": true
  }
}
```

- `database_id` — the target Notion database (UUID, with or without dashes).
- `data` — a flat object whose keys are property names in the target database.

The worker fetches the database schema, then for each key in `data` it picks the matching property (case-insensitive fallback) and encodes the value according to that property's type. Keys that don't match any property are skipped with a console warning. Values that don't fit (e.g. a non-numeric string into a `number` property) are skipped.

Supported property types: `title`, `rich_text`, `number`, `checkbox`, `select`, `multi_select`, `date`, `url`, `email`, `phone_number`.

## Setup

```bash
npm install
curl -fsSL https://ntn.dev | bash   # install Notion CLI if you don't have it
ntn login
```

Optional shared secret. If set, every inbound request must carry `x-webhook-secret: <value>`:

```bash
ntn workers env set LIBRETTO_API_KEY=<libretto-api-key>
ntn workers env set WEBHOOK_SHARED_SECRET=<random-string>
```

Type-check:

```bash
npm run type-check
```

Deploy and grab the URL:

```bash
ntn workers deploy
ntn workers webhooks list
```

The listed URL looks like `https://www.notion.so/webhooks/worker/<spaceId>/<workerId>/<webhookSecret>/insertIntoDatabase`. The path segment before the webhook name acts as a shared secret — treat the whole URL as confidential.

## Triggering the webhook

It's just a POST. Any HTTP client can call it.

```bash
curl -X POST '<WEBHOOK_URL>' \
  -H 'Content-Type: application/json' \
  -d '{
    "database_id": "cdea7ded34f04440897458af4957e00f",
    "data": {
      "Title": "Mid-century chair",
      "Price": 240,
      "Category": "Furniture",
      "Tags": ["urgent", "cheap"],
      "Available": true
    }
  }'
```

If `WEBHOOK_SHARED_SECRET` is set, add `-H 'x-webhook-secret: <value>'`.

The worker's permission to write into a given database is granted in the Notion UI when you install/configure the worker on a workspace — make sure both test databases below are shared with the worker before calling it.

## Test databases

Two databases with different shapes were created under the [Notion hackathon](https://www.notion.so/Notion-hackathon-35fac9fb35f180fdb66bfd7b1b6dbff5) page so you can exercise the same worker against unrelated schemas.

### Test DB · Marketplace Listings
`database_id`: `cdea7ded34f04440897458af4957e00f`

| Property   | Type          | Notes                                       |
|------------|---------------|---------------------------------------------|
| Title      | title         |                                             |
| URL        | url           |                                             |
| Price      | number        | dollar-formatted                            |
| Location   | rich_text     |                                             |
| Posted     | date          | ISO string, e.g. `"2026-05-15"`             |
| Category   | select        | `Furniture` / `Electronics` / `Vehicles` / `Other` |
| Tags       | multi_select  | `urgent` / `cheap` / `new` / `used`         |
| Available  | checkbox      |                                             |

### Test DB · Social Mentions
`database_id`: `939ebe7c296242e1ad8c69d4f8066374`

| Property         | Type       | Notes                                            |
|------------------|------------|--------------------------------------------------|
| Post             | title      |                                                  |
| Author           | rich_text  |                                                  |
| Platform         | select     | `LinkedIn` / `X` / `Reddit` / `Facebook`         |
| Author Email     | email      |                                                  |
| Post URL         | url        |                                                  |
| Sentiment Score  | number     |                                                  |
| Captured At      | date       |                                                  |
| Worth Replying   | checkbox   |                                                  |
| Notes            | rich_text  |                                                  |

### Example payload for the second DB

```json
{
  "database_id": "939ebe7c296242e1ad8c69d4f8066374",
  "data": {
    "Post": "We just shipped agentic browsing — feedback wanted!",
    "Author": "Jane Doe",
    "Platform": "LinkedIn",
    "Author Email": "jane@example.com",
    "Post URL": "https://linkedin.com/posts/jane/123",
    "Sentiment Score": 0.74,
    "Captured At": "2026-05-16",
    "Worth Replying": true,
    "Notes": "Mentions our competitor positively"
  }
}
```
