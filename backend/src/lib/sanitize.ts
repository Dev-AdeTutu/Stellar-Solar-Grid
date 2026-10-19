/**
 * #738 — XSS sanitization for user-supplied content (meter notes).
 *
 * Meter note text may contain a small set of safe formatting markup. Input is
 * sanitized at the single write choke point (addMeterNote) using an allow-list
 * approach:
 *   - Only a small whitelist of formatting tags may survive.
 *   - Only safe attributes are kept (event handlers are never allowed).
 *   - href values must use safe schemes (http/https/mailto/tel) or be relative.
 *   - Every character outside a whitelisted tag is HTML-entity encoded so a
 *     stray `<script>` (or unbalanced markup) renders as inert text.
 *
 * This module intentionally has NO runtime dependencies beyond the platform:
 * a DOM is not available in the backend, so we hand-roll tokenization instead
 * of pulling in jsdom + isomorphic-dompurify.
 */

const HTML_ENTITY_MAP: Record<string, string> = {
  "&": "&amp;",
  "<": "&lt;",
  ">": "&gt;",
  '"': "&quot;",
  "'": "&#x27;",
};

/** Encode the five HTML-special characters in `value`. */
export function encodeHtmlEntities(value: string): string {
  return value.replace(/[&<>"']/g, (ch) => HTML_ENTITY_MAP[ch] ?? ch);
}

export const DEFAULT_ALLOWED_TAGS: ReadonlySet<string> = new Set([
  "a",
  "b",
  "blockquote",
  "br",
  "code",
  "em",
  "i",
  "li",
  "ol",
  "p",
  "pre",
  "span",
  "strong",
  "u",
  "ul",
]);

const ALLOWED_ATTRIBUTES: Record<string, ReadonlySet<string>> = {
  a: new Set(["href", "title"]),
  span: new Set(["title"]),
};

const SAFE_URL_SCHEMES = new Set(["http:", "https:", "mailto:", "tel:"]);

function isSafeUrl(value: string): boolean {
  const trimmed = value.trim();
  if (trimmed === "") {
    return false;
  }
  const lowercase = trimmed.toLowerCase();
  // Relative links (/docs, #section) inherit the page's origin and are safe.
  if (!/^[a-z][a-z0-9+.-]*:/.test(lowercase) && !lowercase.startsWith("//")) {
    return true;
  }
  // Protocol-relative URLs resolve to http(s) in browsers, never javascript:.
  if (lowercase.startsWith("//")) {
    return true;
  }
  const scheme = lowercase.split(":")[0] + ":";
  return SAFE_URL_SCHEMES.has(scheme);
}

/**
 * Reads a balanced attribute list into ordered [name, value] pairs, decoding
 * regex captures from either a double-quoted, single-quoted or unquoted value.
 */
function extractAttributes(raw: string): Array<{ name: string; value: string }> {
  const attrs: Array<{ name: string; value: string }> = [];
  const attrRe = /([a-zA-Z_:][-a-zA-Z0-9:._]*)\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'=<>`]+))/g;
  let match: RegExpExecArray | null;
  while ((match = attrRe.exec(raw)) !== null) {
    const name = match[1]!.toLowerCase();
    const value = match[2] ?? match[3] ?? match[4] ?? "";
    attrs.push({ name, value });
  }
  return attrs;
}

function sanitizeAttributes(tagName: string, rawAttrs: string): string {
  const allowed = ALLOWED_ATTRIBUTES[tagName];
  if (!allowed) {
    return "";
  }
  const kept: Array<string> = [];
  for (const { name, value } of extractAttributes(rawAttrs)) {
    if (name.startsWith("on")) {
      continue; // strip all event handlers (onclick, onerror, ...)
    }
    if (!allowed.has(name)) {
      continue; // attribute not in this tag's allow-list
    }
    if (name === "href" && !isSafeUrl(value)) {
      continue; // strip javascript: / data: / vbscript: URLs
    }
    kept.push(`${name}="${encodeHtmlEntities(value)}"`);
  }
  return kept.length > 0 ? " " + kept.join(" ") : "";
}

/**
 * Sanitize a free-form HTML-ish string. Whitelisted tags survive with safe
 * attributes only; everything else (including the angle brackets of any
 * disallowed tag) is entity-encoded so it renders as literal text.
 */
export function sanitizeUserHtml(
  value: string,
  allowedTags: ReadonlySet<string> = DEFAULT_ALLOWED_TAGS,
): string {
  if (typeof value !== "string") {
    return "";
  }
  if (value === "") {
    return "";
  }
  // Fast path: nothing that looks like markup.
  if (!/[<>&]/.test(value)) {
    return value;
  }

  const tagRe = /<\s*(\/)?\s*([a-zA-Z][a-zA-Z0-9-]*)([^>]*)>/g;
  let out = "";
  let lastIndex = 0;
  let match: RegExpExecArray | null;

  while ((match = tagRe.exec(value)) !== null) {
    out += encodeHtmlEntities(value.slice(lastIndex, match.index));

    const closing = match[1] ?? "";
    const tagName = (match[2] ?? "").toLowerCase();
    const rawAttrs = match[3] ?? "";

    if (!allowedTags.has(tagName)) {
      // Disallowed tag — neutralize it entirely.
      out += encodeHtmlEntities(match[0]);
    } else {
      const attrs = sanitizeAttributes(tagName, rawAttrs);
      out += `<${closing}${tagName}${attrs}>`;
    }
    lastIndex = match.index + match[0].length;
  }

  out += encodeHtmlEntities(value.slice(lastIndex));
  return out;
}
