// Gets HUMAN (PerimeterX) cookies through your proxy, and solves the
// press-and-hold challenge if one of your own requests is blocked.
//
//   BYPASS_FAST_API_KEY=... PROXY_URL=http://user:pass@host:port node examples/perimeterx-init-and-hold.mjs
//
// Prints counts only: cookies, sessions and proxy URLs are credentials.
import { APIError, BypassFast } from "bypassfast";

const apiKey = process.env.BYPASS_FAST_API_KEY;
const proxy = process.env.PROXY_URL;
if (!apiKey || !proxy) {
  console.error("usage: BYPASS_FAST_API_KEY=... PROXY_URL=... node perimeterx-init-and-hold.mjs");
  process.exit(2);
}

const client = new BypassFast(apiKey);

/**
 * Replace with your own request to the protected site, sent through the same
 * proxy with init.ua and every init cookie. Return the response exactly as
 * received when it is a HUMAN block (a 428 JSON body with appId and
 * blockScript, or an HTML page containing px-captcha), otherwise null.
 */
async function sendProtectedRequest(_init) {
  return null; // e.g. { url, method: "POST", status: 428, headers: { "content-type": "application/json" }, body }
}

try {
  const init = await client.perimeterx.init({
    url: "https://www.example.com/",
    proxy,
    // app_id: "PX........", // the site's HUMAN app id; required unless the API infers it
  });
  console.log(`init: ${init.cookies.length} cookies`);

  const blocked = await sendProtectedRequest(init);
  if (blocked) {
    const hold = await client.perimeterx.solveHold({ session: init.session, proxy, blocked });
    if (hold.rejected) {
      // A rejected hold is billed and is not an error. Stop here: retrying,
      // even on another exit, can turn an app-wide rule into a retry storm.
      console.log(`hold rejected${hold.changeExit ? " (the solver advises another exit)" : ""}`);
    } else {
      console.log(`hold solved: ${hold.cookies.length} cookies; set them and retry the request once`);
    }
  }
} catch (error) {
  if (error instanceof APIError) {
    const reason = error.reason ? `, reason ${error.reason}` : "";
    console.error(`solve failed: ${error.code}${reason} (status ${error.response.statusCode}, request ${error.response.requestId})`);
    process.exit(1);
  }
  throw error;
}
