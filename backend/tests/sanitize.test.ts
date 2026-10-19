import { describe, it, expect } from "vitest";
import {
  encodeHtmlEntities,
  sanitizeUserHtml,
  DEFAULT_ALLOWED_TAGS,
} from "../src/lib/sanitize";

describe("encodeHtmlEntities", () => {
  it("encodes all five HTML-significant characters", () => {
    expect(encodeHtmlEntities(`<script>alert("x") & 'y'</script>`)).toBe(
      "&lt;script&gt;alert(&quot;x&quot;) &amp; &#x27;y&#x27;&lt;/script&gt;",
    );
  });

  it("leaves plain text without special characters alone", () => {
    expect(encodeHtmlEntities("Checked on-site; panel clean")).toBe(
      "Checked on-site; panel clean",
    );
  });
});

describe("sanitizeUserHtml", () => {
  it("returns an empty string for non-string input", () => {
    expect(sanitizeUserHtml(123 as unknown as string)).toBe("");
    expect(sanitizeUserHtml(null as unknown as string)).toBe("");
  });

  it("neutralizes script tags by encoding the angle brackets", () => {
    expect(sanitizeUserHtml("<script>window.x = 1</script>")).toBe(
      "&lt;script&gt;window.x = 1&lt;/script&gt;",
    );
  });

  it("strips event handlers from otherwise-allowed tags", () => {
    expect(sanitizeUserHtml(`<a href="https://ok.dev" onclick="evil()">go</a>`)).toBe(
      `<a href="https://ok.dev">go</a>`,
    );
  });

  it("blocks javascript:, data: and vbscript: URLs in href attributes", () => {
    expect(sanitizeUserHtml(`<a href="javascript:alert(1)">x</a>`)).toBe(`<a>x</a>`);
    expect(sanitizeUserHtml(`<a href="data:text/html;base64,PHNjcmlwdD4=">x</a>`)).toBe(
      `<a>x</a>`,
    );
    expect(sanitizeUserHtml(`<a href="vbscript:msgbox(1)">x</a>`)).toBe(`<a>x</a>`);
  });

  it("keeps mailto:, tel:, http(s): and relative hrefs", () => {
    expect(sanitizeUserHtml(`<a href="mailto:a@b.co">email</a>`)).toBe(
      `<a href="mailto:a@b.co">email</a>`,
    );
    expect(sanitizeUserHtml(`<a href="/meter/1">m</a>`)).toBe(`<a href="/meter/1">m</a>`);
    expect(sanitizeUserHtml(`<a href="#section">s</a>`)).toBe(`<a href="#section">s</a>`);
  });

  it("encodes disallowed tags so their payload cannot execute", () => {
    const input = `<img src=x onerror="alert(1)">`;
    expect(sanitizeUserHtml(input)).toBe(`&lt;img src=x onerror=&quot;alert(1)&quot;&gt;`);
  });

  it("allows the formatting whitelist", () => {
    const input = `<p>a <strong>b</strong> <em>c</em></p><ul><li>one</li></ul>`;
    expect(sanitizeUserHtml(input)).toBe(input);
  });

  it("encodes stray angle brackets that are not whitelisted markup", () => {
    expect(sanitizeUserHtml("a < b and c > d")).toBe("a &lt; b and c &gt; d");
  });

  it("keeps plain text unchanged (fast path)", () => {
    expect(sanitizeUserHtml("Just a normal note")).toBe("Just a normal note");
  });

  it("accepts a custom allow-list (KEEP_ALL custom tags)", () => {
    const keepAll = new Set([...DEFAULT_ALLOWED_TAGS, "custom"]);
    expect(sanitizeUserHtml(`<custom>x</custom>`, keepAll)).toBe(`<custom>x</custom>`);
  });
});
