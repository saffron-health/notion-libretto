import { WebhookVerificationError, Worker } from "@notionhq/workers";

const worker = new Worker();
export default worker;

type SchemaProperty = { type: string; [key: string]: unknown };
type Schema = Record<string, SchemaProperty>;

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

      const payload = event.body as { data?: unknown; database_id?: unknown };
      const databaseId = payload.database_id;
      const data = payload.data;

      if (typeof databaseId !== "string" || databaseId.length === 0) {
        throw new Error("Missing or invalid `database_id` in payload");
      }
      if (!isPlainObject(data)) {
        throw new Error("Missing or invalid `data` in payload (must be a JSON object)");
      }

      const database = (await notion.databases.retrieve({
        database_id: databaseId,
      })) as unknown as { properties: Schema };

      const properties = buildProperties(data, database.properties);

      const created = await notion.pages.create({
        parent: { database_id: databaseId },
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
