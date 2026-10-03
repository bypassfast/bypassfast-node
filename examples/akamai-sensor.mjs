// Generates Akamai sensor_data for a sensor script your own client fetched.
//
//   BYPASS_FAST_API_KEY=... AKAMAI_BM_SZ=... node examples/akamai-sensor.mjs ./sensor.js
//
// Prints sizes and the script hash only: sensor data and sessions are credentials.
import { readFile } from "node:fs/promises";
import { APIError, BypassFast } from "bypassfast";

const apiKey = process.env.BYPASS_FAST_API_KEY;
const scriptPath = process.argv[2];
if (!apiKey || !scriptPath) {
  console.error("usage: BYPASS_FAST_API_KEY=... AKAMAI_BM_SZ=... node akamai-sensor.mjs <sensor.js>");
  process.exit(2);
}

const client = new BypassFast(apiKey);
const request = {
  url: "https://www.example.com/checkout",
  ua: "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/153.0.0.0 Safari/537.36",
  abck: "0~-1~-1~-1~-1", // the current _abck cookie; this value on the first call
  bm_sz: process.env.AKAMAI_BM_SZ ?? "",
  script: await readFile(scriptPath), // raw bytes; the SDK base64-encodes them
  script_url: "https://www.example.com/_bm/sensor.js",
};

try {
  const first = await client.akamai.sensor(request);
  console.log(`sensor_data: ${first.sensor_data.length} characters, script_id ${first.script_id}`);
  // POST {"sensor_data": first.sensor_data} to the sensor endpoint with
  // first.ua, then use first.session for the next sensor call of this flow.

  // A fresh session with the same script now sends only its script_id.
  const second = await client.akamai.sensor(request);
  console.log(`second call: ${second.response.attempts} attempt(s)`);
} catch (error) {
  if (error instanceof APIError) {
    console.error(`solve failed: ${error.code} (status ${error.response.statusCode}, request ${error.response.requestId})`);
    process.exit(1);
  }
  throw error;
}
