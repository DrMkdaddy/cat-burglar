import { mkdirSync, writeFileSync } from "node:fs";

mkdirSync("assets", { recursive: true });

const esc = (s) =>
  String(s)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;");

function frame(width, height, title, children) {
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}" role="img" aria-label="${esc(title)}">
  <title>${esc(title)}</title>
  <rect width="${width}" height="${height}" rx="18" fill="#ffffff" stroke="#e5e7eb" stroke-width="2"/>
  ${children}
</svg>
`;
}

function bar(x, baseline, width, value, max, color) {
  const height = Math.round((value / max) * 120);
  return `<rect x="${x}" y="${baseline - height}" width="${width}" height="${height}" rx="6" fill="${color}"/>`;
}

const benchmark = frame(
  1000,
  380,
  "Cat Burglar benchmark: adaptive observation cuts text and calls",
  `
  <text x="40" y="52" font-family="Inter, ui-sans-serif, system-ui, -apple-system, Segoe UI, sans-serif" font-size="26" font-weight="700" fill="#111827">Adaptive observation pays</text>
  <text x="40" y="80" font-family="Inter, ui-sans-serif, system-ui, -apple-system, Segoe UI, sans-serif" font-size="14" fill="#6b7280">12 deterministic tasks. Same 12/12 success in both modes. Lower is better.</text>

  <rect x="40" y="108" width="430" height="210" rx="12" fill="#f9fafb" stroke="#e5e7eb"/>
  <text x="64" y="140" font-family="Inter, ui-sans-serif, system-ui, sans-serif" font-size="15" font-weight="600" fill="#111827">Observation characters</text>
  <text x="64" y="162" font-family="Inter, ui-sans-serif, system-ui, sans-serif" font-size="13" fill="#6b7280">Text returned by MCP tools across the suite</text>
  <line x1="64" y1="286" x2="446" y2="286" stroke="#d1d5db" stroke-width="2"/>
  ${bar(96, 286, 90, 30029, 30029, "#94a3b8")}
  <text x="141" y="274" text-anchor="middle" font-family="Inter, ui-sans-serif, system-ui, sans-serif" font-size="18" font-weight="700" fill="#ffffff">30,029</text>
  <text x="141" y="306" text-anchor="middle" font-family="Inter, ui-sans-serif, system-ui, sans-serif" font-size="13" fill="#6b7280">full</text>
  ${bar(296, 286, 90, 21057, 30029, "#16a34a")}
  <text x="341" y="274" text-anchor="middle" font-family="Inter, ui-sans-serif, system-ui, sans-serif" font-size="18" font-weight="700" fill="#ffffff">21,057</text>
  <text x="341" y="306" text-anchor="middle" font-family="Inter, ui-sans-serif, system-ui, sans-serif" font-size="13" fill="#166534">adaptive</text>
  <rect x="296" y="120" width="152" height="26" rx="13" fill="#dcfce7"/>
  <text x="372" y="138" text-anchor="middle" font-family="Inter, ui-sans-serif, system-ui, sans-serif" font-size="13" font-weight="700" fill="#166534">29.9% less text</text>

  <rect x="530" y="108" width="430" height="210" rx="12" fill="#f9fafb" stroke="#e5e7eb"/>
  <text x="554" y="140" font-family="Inter, ui-sans-serif, system-ui, sans-serif" font-size="15" font-weight="600" fill="#111827">Tool calls</text>
  <text x="554" y="162" font-family="Inter, ui-sans-serif, system-ui, sans-serif" font-size="13" fill="#6b7280">Fewer round trips per task</text>
  <line x1="554" y1="286" x2="936" y2="286" stroke="#d1d5db" stroke-width="2"/>
  ${bar(586, 286, 90, 80, 80, "#94a3b8")}
  <text x="631" y="274" text-anchor="middle" font-family="Inter, ui-sans-serif, system-ui, sans-serif" font-size="18" font-weight="700" fill="#ffffff">80</text>
  <text x="631" y="306" text-anchor="middle" font-family="Inter, ui-sans-serif, system-ui, sans-serif" font-size="13" fill="#6b7280">full</text>
  ${bar(786, 286, 90, 68, 80, "#16a34a")}
  <text x="831" y="274" text-anchor="middle" font-family="Inter, ui-sans-serif, system-ui, sans-serif" font-size="18" font-weight="700" fill="#ffffff">68</text>
  <text x="831" y="306" text-anchor="middle" font-family="Inter, ui-sans-serif, system-ui, sans-serif" font-size="13" fill="#166534">adaptive</text>
  <rect x="786" y="120" width="146" height="26" rx="13" fill="#dcfce7"/>
  <text x="859" y="138" text-anchor="middle" font-family="Inter, ui-sans-serif, system-ui, sans-serif" font-size="13" font-weight="700" fill="#166534">15% fewer calls</text>

  <text x="40" y="352" font-family="Inter, ui-sans-serif, system-ui, sans-serif" font-size="12" fill="#6b7280">Profile flash, engine Chromium, Node 26, one run. Raw data: bench/results/2026-11-09-flash.json</text>
  `,
);

const architecture = frame(
  1000,
  470,
  "Cat Burglar architecture: one session, three engines, one observation loop",
  `
  <text x="30" y="46" font-family="Inter, ui-sans-serif, system-ui, sans-serif" font-size="24" font-weight="700" fill="#111827">One session. Three browsers. One loop.</text>
  <text x="30" y="72" font-family="Inter, ui-sans-serif, system-ui, sans-serif" font-size="14" fill="#6b7280">The model asks for a page. The server handles the browser, the diff, the memory, and the guardrails.</text>

  <rect x="30" y="120" width="190" height="240" rx="14" fill="#eff6ff" stroke="#bfdbfe"/>
  <text x="125" y="154" text-anchor="middle" font-family="Inter, ui-sans-serif, system-ui, sans-serif" font-size="16" font-weight="700" fill="#1e3a8a">OpenCode agent</text>
  <text x="125" y="180" text-anchor="middle" font-family="Inter, ui-sans-serif, system-ui, sans-serif" font-size="13" fill="#1e40af">your model</text>
  <text x="125" y="200" text-anchor="middle" font-family="Inter, ui-sans-serif, system-ui, sans-serif" font-size="13" fill="#1e40af">decides the next step</text>
  <text x="125" y="238" text-anchor="middle" font-family="Inter, ui-sans-serif, system-ui, sans-serif" font-size="13" fill="#1e40af">navigate</text>
  <text x="125" y="260" text-anchor="middle" font-family="Inter, ui-sans-serif, system-ui, sans-serif" font-size="13" fill="#1e40af">snapshot / diff</text>
  <text x="125" y="282" text-anchor="middle" font-family="Inter, ui-sans-serif, system-ui, sans-serif" font-size="13" fill="#1e40af">click / fill / wait</text>
  <text x="125" y="304" text-anchor="middle" font-family="Inter, ui-sans-serif, system-ui, sans-serif" font-size="13" fill="#1e40af">read the change</text>

  <rect x="280" y="88" width="360" height="304" rx="14" fill="#f0fdf4" stroke="#bbf7d0"/>
  <text x="460" y="124" text-anchor="middle" font-family="Inter, ui-sans-serif, system-ui, sans-serif" font-size="16" font-weight="700" fill="#14532d">Cat Burglar MCP</text>
  <rect x="310" y="146" width="300" height="34" rx="8" fill="#ffffff" stroke="#86efac"/>
  <text x="460" y="168" text-anchor="middle" font-family="Inter, ui-sans-serif, system-ui, sans-serif" font-size="13" fill="#166534">snapshot with stable refs</text>
  <rect x="310" y="190" width="300" height="34" rx="8" fill="#ffffff" stroke="#86efac"/>
  <text x="460" y="212" text-anchor="middle" font-family="Inter, ui-sans-serif, system-ui, sans-serif" font-size="13" fill="#166534">diff + post-action observation</text>
  <rect x="310" y="234" width="300" height="34" rx="8" fill="#ffffff" stroke="#86efac"/>
  <text x="460" y="256" text-anchor="middle" font-family="Inter, ui-sans-serif, system-ui, sans-serif" font-size="13" fill="#166534">per-origin hints and workflows</text>
  <rect x="310" y="278" width="300" height="34" rx="8" fill="#ffffff" stroke="#86efac"/>
  <text x="460" y="300" text-anchor="middle" font-family="Inter, ui-sans-serif, system-ui, sans-serif" font-size="13" fill="#166534">model profiles: local / flash / frontier</text>
  <rect x="310" y="322" width="300" height="34" rx="8" fill="#ffffff" stroke="#86efac"/>
  <text x="460" y="344" text-anchor="middle" font-family="Inter, ui-sans-serif, system-ui, sans-serif" font-size="13" fill="#166534">risk gate and provenance markers</text>

  <rect x="700" y="88" width="270" height="304" rx="14" fill="#faf5ff" stroke="#e9d5ff"/>
  <text x="835" y="124" text-anchor="middle" font-family="Inter, ui-sans-serif, system-ui, sans-serif" font-size="16" font-weight="700" fill="#4c1d95">Engine switch</text>
  <rect x="726" y="146" width="218" height="66" rx="10" fill="#ffffff" stroke="#d8b4fe"/>
  <text x="835" y="174" text-anchor="middle" font-family="Inter, ui-sans-serif, system-ui, sans-serif" font-size="14" font-weight="700" fill="#6b21a8">Patchright</text>
  <text x="835" y="195" text-anchor="middle" font-family="Inter, ui-sans-serif, system-ui, sans-serif" font-size="12" fill="#7e22ce">stealth Chromium</text>
  <rect x="726" y="224" width="218" height="66" rx="10" fill="#ffffff" stroke="#d8b4fe"/>
  <text x="835" y="252" text-anchor="middle" font-family="Inter, ui-sans-serif, system-ui, sans-serif" font-size="14" font-weight="700" fill="#6b21a8">Chromium</text>
  <text x="835" y="273" text-anchor="middle" font-family="Inter, ui-sans-serif, system-ui, sans-serif" font-size="12" fill="#7e22ce">devtools and traces</text>
  <rect x="726" y="302" width="218" height="66" rx="10" fill="#ffffff" stroke="#d8b4fe"/>
  <text x="835" y="330" text-anchor="middle" font-family="Inter, ui-sans-serif, system-ui, sans-serif" font-size="14" font-weight="700" fill="#6b21a8">Obscura</text>
  <text x="835" y="351" text-anchor="middle" font-family="Inter, ui-sans-serif, system-ui, sans-serif" font-size="12" fill="#7e22ce">43 MB Rust engine</text>

  <line x1="220" y1="240" x2="270" y2="240" stroke="#9ca3af" stroke-width="3"/>
  <polygon points="270,240 260,234 260,246" fill="#9ca3af"/>
  <line x1="640" y1="240" x2="690" y2="240" stroke="#9ca3af" stroke-width="3"/>
  <polygon points="690,240 680,234 680,246" fill="#9ca3af"/>

  <rect x="30" y="418" width="940" height="34" rx="10" fill="#111827"/>
  <text x="500" y="440" text-anchor="middle" font-family="Inter, ui-sans-serif, system-ui, sans-serif" font-size="12.5" fill="#f9fafb">SSRF guard · origin allowlist · untrusted-content markers · tracker blocking · high-impact action gate</text>
  `,
);

writeFileSync("assets/benchmark.svg", benchmark);
writeFileSync("assets/architecture.svg", architecture);
console.log("wrote assets/benchmark.svg and assets/architecture.svg");
