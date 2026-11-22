# Assigned issues #1151 and #1153: delivery notes

Both descriptions refer to code that is not present on current `main`. This PR fixes the real underlying behaviour in the files that exist.

## #1151 Delete an emergency contact

The issue describes a missing `DELETE` route. On `main`, `backend/src/routes/emergencyContacts.ts` only had POST and GET. Added:

- `DELETE /api/users/emergency-contacts/:id?user_address=G...`
- 400 for a missing or non-numeric id via `DeleteEmergencyContactParamsSchema` (`z.coerce.number().int().positive()`).
- 400 for a missing or malformed `user_address` via `DeleteEmergencyContactQuerySchema`.
- 404 for a contact that does not exist or belongs to another user, because `deleteEmergencyContact(user_address, id)` already scopes its `DELETE` to `WHERE id = ? AND user_address = ?`.
- 200 with `{ deleted: true, id }` on success.

Also defined `AddEmergencyContactSchema` and `ListEmergencyContactsQuerySchema` in `backend/src/lib/validation.ts`; the route already imported them but they were absent, so POST/GET validation was silently skipped at runtime.

## #1153 Timezone-aware analytics buckets

The issue names `/api/analytics/consumption`, which does not exist on `main`. The actual UTC bug is in `formatBucket` for `/api/analytics/usage` in `backend/src/routes/analytics.ts`: it used `toISOString()` and UTC getters, so a late-evening event landed on the next UTC day. Added:

- `backend/src/lib/analyticsTimezone.ts` with `isValidTimezone`, `resolveTimezone` and `createBucketFormatter`.
- `?timezone=` is validated: an unknown IANA zone returns 400, an empty value defaults to `UTC`.
- One `Intl.DateTimeFormat` is created per request and reused for every row, with daily, weekly (Monday start) and monthly buckets derived in the requested local calendar.
- `timezone` is now part of the cache key so two callers asking for different zones cannot share results, and it is echoed in the response summary.
- The per-bucket average is computed in the same row pass instead of re-filtering all rows per bucket.

## Tests

- 9 zero-dependency `node --test` tests pass (5 timezone/bucket, 4 validation schemas), run from `backend/` with `node --test src/lib/*.test.mjs`.
- `npx eslint` passes on every changed file.
- `npm run build` still fails with the same 29 pre-existing TS syntax errors (merge conflict markers and unclosed blocks in unrelated files) as the clean baseline; no new errors were introduced.
- `npm test` (vitest) is unchanged from baseline: 31 failed files, 18 failed tests, 268 passed. The failures are pre-existing and unrelated.
- A real HTTP integration test with supertest was not added because the dependency is not present; route validation is verified directly against the schemas instead.
