import { runTelemetryRequest, type CliUsagePayload } from "./telemetry.js";

interface TelemetryEnvelope {
  endpoint: string;
  payload: CliUsagePayload;
}

async function main(): Promise<void> {
  const encoded = process.argv[2];
  if (!encoded) return;
  try {
    const envelope = JSON.parse(Buffer.from(encoded, "base64url").toString("utf8")) as TelemetryEnvelope;
    await runTelemetryRequest(envelope.endpoint, envelope.payload);
  } catch {
    // Detached analytics failures are intentionally silent.
  }
}

await main();
