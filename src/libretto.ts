export type JsonValue =
  | string
  | number
  | boolean
  | null
  | JsonValue[]
  | { [key: string]: JsonValue };

export type JsonObject = { [key: string]: JsonValue };

const LIBRETTO_API_BASE_URL = "https://api.libretto.sh";

export async function callLibretto(
  path: string,
  payload: JsonObject,
): Promise<JsonValue> {
  const apiKey = process.env.LIBRETTO_API_KEY;
  if (!apiKey) {
    throw new Error("LIBRETTO_API_KEY is not configured");
  }

  const response = await fetch(`${LIBRETTO_API_BASE_URL}${path}`, {
    method: "POST",
    headers: {
      "x-api-key": apiKey,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ json: payload }),
  });

  const body = (await response.json().catch(() => ({}))) as unknown;

  if (!response.ok) {
    throw new Error(
      `Libretto API request failed: ${response.status} ${JSON.stringify(body)}`,
    );
  }

  if (!isJsonValue(body)) {
    throw new Error("Libretto API returned a non-JSON response");
  }

  return body;
}

export function parseJsonObject(value: string, label: string): JsonObject {
  const parsed = JSON.parse(value) as unknown;
  if (!isJsonObject(parsed)) {
    throw new Error(`${label} must be a JSON object`);
  }
  return parsed;
}

function isJsonObject(value: unknown): value is JsonObject {
  return (
    value !== null &&
    typeof value === "object" &&
    !Array.isArray(value) &&
    Object.values(value).every(isJsonValue)
  );
}

function isJsonValue(value: unknown): value is JsonValue {
  if (
    value === null ||
    typeof value === "string" ||
    typeof value === "number" ||
    typeof value === "boolean"
  ) {
    return true;
  }

  if (Array.isArray(value)) {
    return value.every(isJsonValue);
  }

  return isJsonObject(value);
}
