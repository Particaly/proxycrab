#!/usr/bin/env node
import {
  apiRequest,
  assertAllowedArgs,
  optionalInteger,
  parseArgs,
  printHelp,
  printJson,
  requiredInteger,
  run,
  sessionQuery,
} from "./lib/common.mjs";

// Client-side truncation for large string bodies: type "text" content and type "json" string
// content are cut to maxLength characters with a suffix carrying the original char count; JSON
// object content and other types are left untouched.
function truncateBody(body, maxLength) {
  if (body === null || typeof body !== "object") return body;
  if (body.type !== "text" && body.type !== "json") return body;
  const { content } = body;
  if (typeof content !== "string" || content.length <= maxLength) return body;
  return {
    ...body,
    content: `${content.slice(0, maxLength)}…[truncated ${content.length} chars total]`,
  };
}

run(async () => {
  const args = parseArgs();
  assertAllowedArgs(args, ["session-id", "log-id", "max-body-length"]);
  if (args.help) {
    printHelp(`
Usage: node log-get.mjs --log-id ID [--session-id ID] [--max-body-length N] [--base-url URL]

Read one complete capture detail. Omitting --session-id uses the active Session.
Raw headers and bodies are not redacted.

  --max-body-length N    Truncate text bodies client-side before printing: "text" content and
                         "json" string content longer than N characters are cut to N characters
                         with a trailing "…[truncated X chars total]" marker (X = the original
                         character count). JSON object bodies are never truncated.
`);
    return;
  }
  const sessionId = optionalInteger(args, "session-id", { min: 1 });
  const logId = requiredInteger(args, "log-id", { min: 1 });
  const maxBodyLength = optionalInteger(args, "max-body-length", { min: 1 });
  const detail = await apiRequest(args, `/api/logs/${logId}${sessionQuery(sessionId)}`);
  if (maxBodyLength === undefined) {
    printJson(detail);
    return;
  }
  const truncated = { ...detail };
  if (truncated.request !== undefined) {
    truncated.request = {
      ...truncated.request,
      body: truncateBody(truncated.request.body, maxBodyLength),
    };
  }
  if (truncated.response !== undefined) {
    truncated.response = {
      ...truncated.response,
      body: truncateBody(truncated.response.body, maxBodyLength),
    };
  }
  printJson(truncated);
});
