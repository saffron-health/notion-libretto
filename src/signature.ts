import { createHmac, timingSafeEqual } from "node:crypto";

export function verifyHmacSha256Signature(args: {
  rawBody: string;
  headers: Record<string, string>;
  secret: string;
  headerName: string;
}): boolean {
  const signature = args.headers[args.headerName.toLowerCase()];
  if (!signature) {
    return false;
  }

  const expected = createHmac("sha256", args.secret)
    .update(args.rawBody)
    .digest("hex");

  const normalizedExpected = signature.startsWith("sha256=")
    ? `sha256=${expected}`
    : expected;

  if (signature.length !== normalizedExpected.length) {
    return false;
  }

  return timingSafeEqual(
    Buffer.from(signature),
    Buffer.from(normalizedExpected),
  );
}
