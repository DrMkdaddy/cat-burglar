import TurndownService from "turndown";
import type { ReadableResult } from "./page-scripts.js";

const turndown = new TurndownService({
  headingStyle: "atx",
  hr: "---",
  bulletListMarker: "-",
  codeBlockStyle: "fenced",
  emDelimiter: "_",
  strongDelimiter: "**",
  linkStyle: "inlined",
});

turndown.remove(["script", "style", "noscript", "template"]);

// Keep tables readable; Turndown's core drops them to plain text.
turndown.addRule("table", {
  filter: "table",
  replacement(_content, node) {
    const rows = Array.from((node as Element).querySelectorAll("tr"));
    if (rows.length === 0) return "";
    const cells = rows.map((row) =>
      Array.from(row.querySelectorAll("th, td")).map((cell) =>
        (cell.textContent ?? "").replace(/\s+/g, " ").trim().replace(/\|/g, "\\|"),
      ),
    );
    const width = Math.max(...cells.map((row) => row.length));
    if (width === 0) return "";
    const padded = cells.map((row) => [...row, ...Array(width - row.length).fill("")]);
    const header = padded[0]!;
    const separator = header.map(() => "---");
    const body = padded.slice(1);
    return [
      `| ${header.join(" | ")} |`,
      `| ${separator.join(" | ")} |`,
      ...body.map((row) => `| ${row.join(" | ")} |`),
    ].join("\n") + "\n\n";
  },
});

turndown.addRule("emptyLinks", {
  filter: (node) =>
    node.nodeName === "A" && !(node.textContent ?? "").trim() && !node.querySelector("img"),
  replacement: () => "",
});

turndown.addRule("images", {
  filter: "img",
  replacement(_content, node) {
    const el = node as HTMLImageElement;
    const src = el.getAttribute("src") ?? "";
    if (!src || src.startsWith("data:")) return "";
    const alt = (el.getAttribute("alt") ?? "").replace(/\s+/g, " ").trim();
    const title = el.getAttribute("title");
    return `![${alt}](${src}${title ? ` "${title}"` : ""})`;
  },
});

export interface MarkdownResult {
  markdown: string;
  title: string;
  url: string;
  truncated: boolean;
  chars: number;
}

export function readableToMarkdown(readable: ReadableResult, maxChars: number): MarkdownResult {
  let markdown: string;
  try {
    markdown = turndown.turndown(readable.html);
  } catch (error) {
    markdown = (readable.html ?? "").replace(/<[^>]+>/g, " ");
  }

  markdown = markdown
    .replace(/\r\n/g, "\n")
    .replace(/[ \t]+\n/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .replace(/^#{1,6}\s*$/gm, "")
    .trim();

  const header = [
    readable.title ? `# ${readable.title}` : "",
    readable.siteName ? `_${readable.siteName}_` : "",
    readable.byline ? `By ${readable.byline}` : "",
    readable.url ? `<${readable.url}>` : "",
  ]
    .filter(Boolean)
    .join("\n\n");

  const body = header ? `${header}\n\n${markdown}` : markdown;
  const chars = body.length;
  const truncated = chars > maxChars;
  return {
    markdown: truncated ? `${body.slice(0, maxChars)}\n\n… [truncated at ${maxChars} chars]` : body,
    title: readable.title,
    url: readable.url,
    truncated,
    chars,
  };
}
