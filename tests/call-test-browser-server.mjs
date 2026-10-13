import { writeFileSync } from "node:fs";
import { chromium } from "playwright";
import { startCallTestGateways } from "./call-test-https-proxy.mjs";

// Both browsers pin one gateway certificate: each node's public origin is
// served by the other browser's gateway, so each browser must trust both.
const { PIGEON_TEST_TLS_KEY: key, PIGEON_TEST_TLS_CERT: cert } = process.env;
if (!key || !cert)
  throw new Error(
    "PIGEON_TEST_TLS_KEY and PIGEON_TEST_TLS_CERT must be set by the runner",
  );
// Bound on all interfaces so peers reach this node through its public address.
const gateways = await startCallTestGateways(
  ["127.0.0.1", "127.0.0.1"],
  "0.0.0.0",
  { key, cert },
);
const browser = await chromium.launchServer({
  host: "0.0.0.0",
  port: 9222,
  wsPath: "pigeon",
  args: [
    "--use-fake-device-for-media-stream",
    "--use-fake-ui-for-media-stream",
    "--autoplay-policy=no-user-gesture-required",
    `--ignore-certificate-errors-spki-list=${gateways.spki}`,
  ],
});
writeFileSync("/tmp/browser-ready", "ready");
process.once("SIGTERM", async () => {
  await browser.close();
  await gateways.stop();
});
