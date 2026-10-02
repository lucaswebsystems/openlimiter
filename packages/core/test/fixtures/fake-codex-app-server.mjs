import readline from "node:readline";

const scenario = process.env["OPENLIMITER_FAKE_CODEX_SCENARIO"] ?? "success";
if (scenario === "exit-before-read") process.exit(0);

const input = readline.createInterface({ input: process.stdin });
let initializeComplete = false;
let initializedNotification = false;

function send(message) {
  process.stdout.write(JSON.stringify(message) + "\n");
}

input.on("line", (line) => {
  const message = JSON.parse(line);
  if (message.method === "initialize") {
    if (scenario === "oversized-no-newline") {
      process.stdout.write("x".repeat(1_048_577));
      return;
    }
    const expected = {
      name: "openlimiter",
      title: "OpenLimiter",
      version: "2.0.3"
    };
    if (message.jsonrpc !== undefined ||
        JSON.stringify(message.params?.clientInfo) !== JSON.stringify(expected) ||
        message.params?.capabilities?.experimentalApi !== true) {
      send({ id: message.id, error: { code: -32602, message: "invalid initialize" } });
      return;
    }
    initializeComplete = true;
    send({ id: message.id, result: { userAgent: "fake", platformFamily: "test", platformOs: "test" } });
    return;
  }
  if (message.method === "initialized") {
    initializedNotification = initializeComplete && message.id === undefined;
    return;
  }
  if (message.method !== "account/rateLimits/read") return;
  if (!initializedNotification || message.params !== undefined) {
    send({ id: message.id, error: { code: -32600, message: "handshake required" } });
    return;
  }
  if (scenario === "timeout") return;
  if (scenario === "signed-out" || scenario === "signed-out-codex") {
    send({
      id: message.id,
      error: {
        code: -32600,
        message: scenario === "signed-out-codex"
          ? "codex account authentication required to read rate limits"
          : "chatgpt authentication required to read rate limits"
      }
    });
    return;
  }
  if (scenario === "protocol-error") {
    send({ id: message.id, error: { code: -32603, message: "synthetic protocol failure" } });
    return;
  }
  send({
    id: message.id,
    result: {
      ...(scenario === "missing-identity" ? {} : {
        accountId: scenario === "identity-mismatch"
          ? "synthetic-other-account"
          : scenario === "null-identity" ? null : "synthetic-chatgpt-account"
      }),
      rateLimits: {
        limitId: "codex",
        primary: { usedPercent: 23, windowDurationMins: 300, resetsAt: 1_798_778_400 },
        secondary: { usedPercent: 47, windowDurationMins: 10_080, resetsAt: 1_799_365_200 }
      },
      rateLimitsByLimitId: {
        codex: {
          limitId: "codex",
          primary: { usedPercent: 23, windowDurationMins: 300, resetsAt: 1_798_778_400 },
          secondary: { usedPercent: 47, windowDurationMins: 10_080, resetsAt: 1_799_365_200 }
        }
      }
    }
  });
});
