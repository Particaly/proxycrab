#!/usr/bin/env node
import { createWriteStream } from "node:fs";
import path from "node:path";
import { pipeline } from "node:stream/promises";
import {
  ApiError,
  assertAllowedArgs,
  normalizeBaseUrl,
  optionalInteger,
  parseArgs,
  printHelp,
  printJson,
  requestHeaders,
  REQUEST_TIMEOUT_MS,
  requiredString,
  run,
} from "./lib/common.mjs";

const DEFAULT_MAX_SIZE = 16 * 1024 * 1024;

run(async () => {
  const args = parseArgs();
  assertAllowedArgs(args, ["id", "out", "max-size"]);
  if (args.help) {
    printHelp(`
Usage: node request-library-body.mjs --id ID --out FILE [--max-size BYTES] [--base-url URL]

Download the raw stored request body of one request-library entry (blob bytes, or the inline
text with encoding "base64" decoded) into FILE. The HAR mimeType is served as Content-Type and
response encoding is negotiated like the log body endpoint. max_size is checked before reading;
entries without a stored body return 404 body_not_found.

  --id ID                Request-library entry (required)
  --out FILE             Destination file for the raw bytes (required)
  --max-size BYTES       Maximum stored bytes to read; default 16777216 (16 MiB)
`);
    return;
  }
  const id = requiredString(args, "id");
  const output = path.resolve(requiredString(args, "out"));
  const maxSize = optionalInteger(args, "max-size", { min: 1 }) ?? DEFAULT_MAX_SIZE;
  const url = new URL(
    `${normalizeBaseUrl(args)}/api/request-library/${encodeURIComponent(id)}/body`,
  );
  url.searchParams.set("max_size", String(maxSize));

  let response;
  try {
    response = await fetch(url, {
      headers: requestHeaders(),
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
  } catch (error) {
    throw new Error(`cannot reach ProxyCrab at ${url.origin}: ${error.message}`);
  }
  if (!response.ok) {
    let payload;
    try {
      payload = await response.json();
    } catch {
      payload = undefined;
    }
    const error = payload?.error;
    throw new ApiError(
      response.status,
      error?.code ?? `http_${response.status}`,
      error?.message ?? `ProxyCrab request failed with HTTP ${response.status}`,
      {
        ...(error?.actual_size !== undefined ? { actual_size: error.actual_size } : {}),
        ...(error?.max_size !== undefined ? { max_size: error.max_size } : {}),
      },
    );
  }
  if (!response.body) throw new Error("ProxyCrab returned an empty response stream");
  await pipeline(response.body, createWriteStream(output));
  printJson({
    output,
    stored_size: Number(response.headers.get("x-proxycrab-body-size") ?? 0),
    content_type: response.headers.get("content-type") ?? "application/octet-stream",
  });
});
