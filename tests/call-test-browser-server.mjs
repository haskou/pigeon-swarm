import { writeFileSync } from "node:fs";
import { chromium } from "playwright";
import { startCallTestGateways } from "./call-test-https-proxy.mjs";

const gateways = await startCallTestGateways(["127.0.0.1", "127.0.0.1"]);
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
