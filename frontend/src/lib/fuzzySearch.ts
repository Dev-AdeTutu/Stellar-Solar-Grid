/**
 * Utility for fuzzy search matching across meter properties (ID, nickname, location, status).
 * Supports exact match, substring match, word-boundary match, and typo-tolerant subsequence/distance matching.
 */

export function fuzzyMatch(text: string | null | undefined, query: string): boolean {
  if (!query) return true;
  if (!text) return false;

  const normalizedText = text.toLowerCase().trim();
  const normalizedQuery = query.toLowerCase().trim();

  // 1. Direct substring match
  if (normalizedText.includes(normalizedQuery)) return true;

  // 2. Token-based match (all words in query must match somewhere in text)
  const queryTokens = normalizedQuery.split(/\s+/).filter(Boolean);
  const textTokens = normalizedText.split(/\s+/).filter(Boolean);

  if (queryTokens.length > 0) {
    const allTokensMatch = queryTokens.every((qToken) =>
      textTokens.some((tToken) => tToken.includes(qToken) || isTypoTolerantMatch(tToken, qToken))
    );
    if (allTokensMatch) return true;
  }

  // 3. Subsequence match (characters in query appear in order in text)
  return isSubsequenceMatch(normalizedText, normalizedQuery);
}

function isTypoTolerantMatch(text: string, query: string): boolean {
  if (Math.abs(text.length - query.length) > 2) return false;
  let distance = 0;
  const len = Math.min(text.length, query.length);
  for (let i = 0; i < len; i++) {
    if (text[i] !== query[i]) distance++;
    if (distance > 2) return false;
  }
  return distance <= (query.length > 4 ? 2 : 1);
}

function isSubsequenceMatch(text: string, query: string): boolean {
  let textIdx = 0;
  let queryIdx = 0;
  while (textIdx < text.length && queryIdx < query.length) {
    if (text[textIdx] === query[queryIdx]) {
      queryIdx++;
    }
    textIdx++;
  }
  return queryIdx === query.length;
}
