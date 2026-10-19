#!/usr/bin/env node
/**
 * scripts/check-duplicate-pkg-keys.js
 *
 * Closes #538: detects duplicate top-level and dependency keys in
 * package.json files.
 *
 * Standard JSON.parse() silently uses the last occurrence when a key appears
 * more than once, so `npm install` succeeding is NOT proof that the file is
 * duplicate-free.  This script uses a custom reviver-free parser that counts
 * occurrences and fails with a non-zero exit code on the first duplicate found.
 *
 * Usage:
 *   node scripts/check-duplicate-pkg-keys.js <path/to/package.json> [...]
 *
 * In CI (see .github/workflows/ci.yml):
 *   node scripts/check-duplicate-pkg-keys.js backend/package.json frontend/package.json
 */

import { readFileSync } from "fs";

/**
 * Parse a JSON string while tracking every key occurrence.
 * Returns { parsed, duplicates } where duplicates is an array of
 * { path, key, count } objects.
 */
function parseWithDuplicateCheck(text) {
  const duplicates = [];

  /**
   * Recursive descent parser for JSON objects/arrays.
   * pos is a shared { value: number } cursor so recursion can advance it.
   */
  function parseValue(pos, keyPath) {
    skipWhitespace(pos);
    const ch = text[pos.value];
    if (ch === "{") return parseObject(pos, keyPath);
    if (ch === "[") return parseArray(pos, keyPath);
    if (ch === '"') return parseString(pos);
    if (ch === "t" || ch === "f" || ch === "n") return parseLiteral(pos);
    return parseNumber(pos);
  }

  function parseObject(pos, keyPath) {
    pos.value++; // consume '{'
    skipWhitespace(pos);
    const seen = new Map();
    const obj = {};
    if (text[pos.value] === "}") { pos.value++; return obj; }
    while (true) {
      skipWhitespace(pos);
      const key = parseString(pos);
      const fullPath = keyPath ? `${keyPath}.${key}` : key;
      const count = (seen.get(key) ?? 0) + 1;
      seen.set(key, count);
      if (count > 1) {
        duplicates.push({ path: fullPath, key, count });
      }
      skipWhitespace(pos);
      pos.value++; // consume ':'
      const val = parseValue(pos, fullPath);
      obj[key] = val;
      skipWhitespace(pos);
      if (text[pos.value] === "}") { pos.value++; break; }
      pos.value++; // consume ','
    }
    return obj;
  }

  function parseArray(pos, keyPath) {
    pos.value++; // consume '['
    skipWhitespace(pos);
    const arr = [];
    if (text[pos.value] === "]") { pos.value++; return arr; }
    while (true) {
      const val = parseValue(pos, keyPath);
      arr.push(val);
      skipWhitespace(pos);
      if (text[pos.value] === "]") { pos.value++; break; }
      pos.value++; // consume ','
    }
    return arr;
  }

  function parseString(pos) {
    pos.value++; // consume opening '"'
    let str = "";
    while (pos.value < text.length) {
      const ch = text[pos.value];
      if (ch === '"') { pos.value++; return str; }
      if (ch === "\\") {
        pos.value++;
        const esc = text[pos.value];
        str += esc === "n" ? "\n" : esc === "t" ? "\t" : esc === "r" ? "\r" : esc;
      } else {
        str += ch;
      }
      pos.value++;
    }
    return str;
  }

  function parseLiteral(pos) {
    if (text.startsWith("true", pos.value)) { pos.value += 4; return true; }
    if (text.startsWith("false", pos.value)) { pos.value += 5; return false; }
    if (text.startsWith("null", pos.value)) { pos.value += 4; return null; }
    throw new Error(`Unexpected token at ${pos.value}`);
  }

  function parseNumber(pos) {
    const start = pos.value;
    while (pos.value < text.length && /[0-9.\-+eE]/.test(text[pos.value])) pos.value++;
    return Number(text.slice(start, pos.value));
  }

  function skipWhitespace(pos) {
    while (pos.value < text.length && /\s/.test(text[pos.value])) pos.value++;
  }

  const pos = { value: 0 };
  const parsed = parseValue(pos, "");
  return { parsed, duplicates };
}

// ── Main ─────────────────────────────────────────────────────────────────────

const files = process.argv.slice(2);

if (files.length === 0) {
  console.error(
    "Usage: node scripts/check-duplicate-pkg-keys.js <package.json> [...]",
  );
  process.exit(1);
}

let anyFailed = false;

for (const file of files) {
  let text;
  try {
    text = readFileSync(file, "utf8");
  } catch (err) {
    console.error(`ERROR: Cannot read ${file}: ${err.message}`);
    anyFailed = true;
    continue;
  }

  let result;
  try {
    result = parseWithDuplicateCheck(text);
  } catch (err) {
    console.error(`ERROR: Failed to parse ${file}: ${err.message}`);
    anyFailed = true;
    continue;
  }

  if (result.duplicates.length === 0) {
    console.log(`OK  ${file} — no duplicate keys found`);
  } else {
    console.error(`FAIL ${file} — duplicate keys detected:`);
    for (const { path, count } of result.duplicates) {
      console.error(`  "${path}" appears ${count} times`);
    }
    anyFailed = true;
  }
}

process.exit(anyFailed ? 1 : 0);
