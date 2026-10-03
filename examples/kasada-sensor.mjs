// Generates a Kasada sensor payload for a p.js your own client fetched.
//
//   BYPASS_FAST_API_KEY=... node examples/kasada-sensor.mjs ./p.js
//
// Prints sizes and header names only: payloads and headers are credentials.
import { readFile } from "node:fs/promises";
import { APIError, BypassFast } from "bypassfast";

const apiKey = process.env.BYPASS_FAST_API_KEY;
const scriptPath = process.argv[2];
if (!apiKey || !scriptPath) {
  console.error("usage: BYPASS_FAST_API_KEY=... node kasada-sensor.mjs <p.js>");
  process.exit(2);
}

const client = new BypassFast(apiKey);

try {
  const result = await client.kasada.sensor({
    script: await readFile(scriptPath, "utf8"), // raw p.js text, not base64
    ua: "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/153.0.0.0 Safari/537.36",
    url: "https://www.example.com/",
  });
  // Send result.payload with every result.headers entry to Kasada, then make
  // the protected request with result.user_agent.
  console.log(`payload: ${result.payload.length} characters`);
  console.log(`headers: ${Object.keys(result.headers ?? {}).join(", ")}`);
  console.log(`request id: ${result.response.requestId}, attempts: ${result.response.attempts}`);
} catch (error) {
  if (error instanceof APIError) {
    console.error(`solve failed: ${error.code} (status ${error.response.statusCode}, request ${error.response.requestId})`);
    process.exit(1);
  }
  throw error;
}
