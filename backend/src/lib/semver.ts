/**
 * Strict SemVer 2.0.0 validation for firmware versions (#1150).
 *
 * Accepts `MAJOR.MINOR.PATCH` with optional `-prerelease` and `+build`
 * suffixes. Leading zeros are rejected in numeric identifiers, as required
 * by the specification.
 */
const SEMVER_RE =
  /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-((?:0|[1-9]\d*|\d*[a-zA-Z-][0-9a-zA-Z-]*)(?:\.(?:0|[1-9]\d*|\d*[a-zA-Z-][0-9a-zA-Z-]*))*))?(?:\+([0-9a-zA-Z-]+(?:\.[0-9a-zA-Z-]+)*))?$/;

export function isValidSemVer(version: unknown): version is string {
  return typeof version === "string" && SEMVER_RE.test(version);
}
