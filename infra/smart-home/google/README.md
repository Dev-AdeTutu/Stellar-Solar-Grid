# Google Home — SolarGrid Smart Home Action (#904)

Google Smart Home Actions are configured in the [Google Home Developer Console](https://console.home.google.com/)
rather than shipped as code. Use these values:

| Setting | Value |
| --- | --- |
| Integration type | Cloud-to-cloud |
| Fulfillment URL | `https://<api-host>/api/smart-home/google/fulfillment` |
| OAuth client ID / secret | `SMART_HOME_GOOGLE_CLIENT_ID` / `SMART_HOME_GOOGLE_CLIENT_SECRET` |
| Authorization URL | `https://<api-host>/api/smart-home/oauth/authorize` |
| Token URL | `https://<api-host>/api/smart-home/oauth/token` |
| Scopes | `read control` |
| Device types | `OUTLET` (meters), `SCENE` (energy routines) |

Set `SMART_HOME_GOOGLE_REDIRECT_URIS=https://oauth-redirect.googleusercontent.com/r/<project-id>` on the backend
(include `https://oauth-redirect-sandbox.googleusercontent.com/r/<project-id>` while testing).

Run the [Smart Home Test Suite](https://developers.home.google.com/tools/smart-home-test-suite) against a linked test
account before submitting for certification. See `docs/SMART_HOME.md` for the full checklist.
