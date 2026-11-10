// Regenerate src/data/tracker-domains.ts from Obscura's public blocklist.
// Obscura is Apache-2.0: https://github.com/h4ckf0r0day/obscura
import { writeFileSync } from "node:fs";

const SOURCE =
  "https://raw.githubusercontent.com/h4ckf0r0day/obscura/main/crates/obscura-net/src/pgl_domains.txt";

const EXTRA = [
  "doubleclick.net",
  "google-analytics.com",
  "googletagmanager.com",
  "googlesyndication.com",
  "googleadservices.com",
  "facebook.net",
  "connect.facebook.net",
  "hotjar.com",
  "hotjar.io",
  "segment.io",
  "segment.com",
  "mixpanel.com",
  "amplitude.com",
  "fullstory.com",
  "mouseflow.com",
  "smartlook.com",
  "clarity.ms",
  "bat.bing.com",
  "adsrvr.org",
  "adnxs.com",
  "criteo.com",
  "taboola.com",
  "outbrain.com",
  "scorecardresearch.com",
  "quantserve.com",
  "newrelic.com",
  "nr-data.net",
  "bugsnag.com",
  "rollbar.com",
  "logrocket.com",
  "lr-ingest.io",
  "heapanalytics.com",
  "stats.wp.com",
  "pixel.wp.com",
];

const response = await fetch(SOURCE);
if (!response.ok) throw new Error(`failed to fetch blocklist: ${response.status}`);
const lines = (await response.text())
  .split(/\r?\n/)
  .map((line) => line.trim())
  .filter((line) => line && !line.startsWith("#"));

const all = [...new Set([...lines, ...EXTRA])].sort();
const output = `// Sourced from Obscura (Apache-2.0) crates/obscura-net/src/pgl_domains.txt
// plus a small set of well-known analytics/tracker hosts.
// https://github.com/h4ckf0r0day/obscura
// Regenerate with scripts/gen-tracker-list.mjs

const DOMAINS: string[] = ${JSON.stringify(all)};

export const TRACKER_DOMAINS = new Set(DOMAINS);
`;

writeFileSync(new URL("../src/data/tracker-domains.ts", import.meta.url), output);
console.log(`wrote ${all.length} domains`);
