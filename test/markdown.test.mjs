import test from "node:test";
import assert from "node:assert/strict";
import { readableToMarkdown } from "../dist/markdown.js";

const readable = {
  title: "Example article",
  url: "https://example.com/post",
  siteName: "Example",
  byline: "Ada",
  html: `
    <h2>Section</h2>
    <p>Hello <a href="https://example.com/next">next</a> and <strong>bold</strong>.</p>
    <table><tr><th>Name</th><th>Value</th></tr><tr><td>A</td><td>1</td></tr></table>
    <p><img src="https://example.com/image.png" alt="Diagram"></p>
    <script>alert('removed')</script>
  `,
};

test("markdown keeps structure, links, tables, and images", () => {
  const result = readableToMarkdown(readable, 8_000);
  assert.match(result.markdown, /## Section/);
  assert.match(result.markdown, /\[next\]\(https:\/\/example\.com\/next\)/);
  assert.match(result.markdown, /\*\*bold\*\*/);
  assert.match(result.markdown, /\| Name \| Value \|/);
  assert.match(result.markdown, /!\[Diagram\]\(https:\/\/example\.com\/image\.png\)/);
  assert.doesNotMatch(result.markdown, /alert/);
  assert.equal(result.truncated, false);
});

test("markdown truncates at the requested budget", () => {
  const result = readableToMarkdown(readable, 120);
  assert.equal(result.truncated, true);
  assert.ok(result.markdown.length < 200);
  assert.match(result.markdown, /truncated at 120 chars/);
});

test("markdown includes title, site, and canonical URL header", () => {
  const result = readableToMarkdown(readable, 8_000);
  assert.match(result.markdown, /^# Example article/);
  assert.match(result.markdown, /_Example_/);
  assert.match(result.markdown, /<https:\/\/example\.com\/post>/);
});
