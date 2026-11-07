#!/usr/bin/env node
import {
  UsageError,
  apiRequest,
  assertAllowedArgs,
  optionalInteger,
  optionalString,
  parseArgs,
  printHelp,
  printJson,
  requiredString,
  run,
} from "./lib/common.mjs";

function parseOverrideJson(raw) {
  let override;
  try {
    override = JSON.parse(raw);
  } catch (error) {
    throw new UsageError(`invalid JSON for --override-json: ${error.message}`);
  }
  if (override === null || typeof override !== "object" || Array.isArray(override)) {
    throw new UsageError("--override-json must be a JSON object");
  }
  return override;
}

run(async () => {
  const args = parseArgs();
  assertAllowedArgs(args, [
    "session-id",
    "library-id",
    "method",
    "url",
    "headers-json",
    "body-text",
    "body-asset-id",
    "body-ref",
    "override-json",
  ]);
  if (args.help) {
    printHelp(`
Usage:
  node replay-send.mjs [--session-id ID] --method M --url U [options] [--base-url URL]
  node replay-send.mjs [--session-id ID] --library-id ID [--override-json JSON] [--base-url URL]

Send one request through a Session's interceptor pipeline (source: ProxyCrabRequest). The proxy
must be running. Returns as soon as the capture is created. Omitting --session-id resolves the
Session from the active one.

Raw request mode:
  --method M             HTTP method
  --url U                Absolute request URL
  --headers-json JSON    Ordered header pairs, e.g. '[["content-type","text/plain"]]'
  --body-text TEXT       UTF-8 text body
  --body-asset-id ID     Workspace asset body
  --body-ref S:L:SIDE    Reuse capture body, e.g. '3:12:request' or '3:12:response'

Request library mode (mutually exclusive with --method/--url/--headers-json/--body-*):
  --library-id ID        Baseline taken from the entry's first HAR request; blob-backed bodies
                         are read back in

Both modes:
  --override-json JSON   Applied on top of the baseline; keys method/url/headers/
                         removed_headers/body are passed through verbatim, e.g.
                         '{"method":"POST","removed_headers":["x-draft"]}'
`);
    return;
  }
  const sessionId = optionalInteger(args, "session-id", { min: 1 });
  const libraryId = optionalString(args, "library-id");
  if (
    libraryId !== undefined &&
    [
      args.method,
      args.url,
      args["headers-json"],
      args["body-text"],
      args["body-asset-id"],
      args["body-ref"],
    ].some((value) => value !== undefined)
  ) {
    throw new UsageError(
      "--library-id cannot be combined with --method/--url/--headers-json/--body-text/--body-asset-id/--body-ref",
    );
  }
  const override =
    args["override-json"] === undefined ? undefined : parseOverrideJson(args["override-json"]);
  const pathname = sessionId === undefined ? "/api/replay" : `/api/replay?session=${sessionId}`;

  if (libraryId !== undefined) {
    printJson(
      await apiRequest(args, pathname, {
        method: "POST",
        body: { library_id: libraryId, ...(override ? { override } : {}) },
      }),
    );
    return;
  }

  const method = requiredString(args, "method");
  const url = requiredString(args, "url");
  const headers = args["headers-json"] ? JSON.parse(args["headers-json"]) : [];
  const bodyModes = [args["body-text"], args["body-asset-id"], args["body-ref"]].filter(
    (value) => value !== undefined,
  );
  if (bodyModes.length > 1) throw new Error("use only one body option");
  let body;
  if (args["body-text"] !== undefined) {
    body = { type: "text", text: args["body-text"], charset: "utf8" };
  } else if (args["body-asset-id"] !== undefined) {
    body = { type: "asset", asset_id: args["body-asset-id"] };
  } else if (args["body-ref"] !== undefined) {
    const match = /^(\d+):(\d+):(request|response)$/.exec(args["body-ref"]);
    if (!match) throw new Error("--body-ref must be '<session>:<log>:request|response'");
    body = {
      type: "body_ref",
      session_id: Number(match[1]),
      log_id: Number(match[2]),
      side: match[3],
    };
  }
  printJson(
    await apiRequest(args, pathname, {
      method: "POST",
      body: {
        method,
        url,
        headers,
        ...(body ? { body } : {}),
        ...(override ? { override } : {}),
      },
    }),
  );
});
