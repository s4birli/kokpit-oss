// The "agent" of the browser e2e: run inside a project terminal, it drives the project's Chrome through
// KOKPIT_CDP_URL with Playwright, like an agent using Playwright MCP's --cdp-endpoint would.
// Usage: node cdp-agent.mjs <url substring of the page to change> <text to write>
import { chromium } from "playwright";

const [match, text] = process.argv.slice(2);
const endpoint = process.env.KOKPIT_CDP_URL;
if (!endpoint || !match || !text) {
  console.error("usage: KOKPIT_CDP_URL=… node cdp-agent.mjs <match> <text>");
  process.exit(2);
}
const browser = await chromium.connectOverCDP(endpoint);
const page = browser
  .contexts()
  .flatMap((c) => c.pages())
  .find((p) => p.url().includes(match));
if (!page) {
  console.error(`AGENT-NO-PAGE ${match}`);
  process.exit(3);
}
await page.evaluate((t) => {
  const h = document.createElement("h1");
  h.id = "agent";
  h.style.fontSize = "64px";
  h.textContent = t;
  document.body.replaceChildren(h);
  document.body.style.background = "rgb(200, 30, 30)";
  document.title = t;
}, text);
console.log(`AGENT-OK ${page.url()}`);
// Leave the browser running: it belongs to the engine, the agent only borrowed it.
process.exit(0);
