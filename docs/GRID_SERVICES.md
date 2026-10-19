# Grid services and meter verification

## Frequency regulation (Issue #1016)

Meters can publish frequency telemetry to the backend and participate in frequency response around the nominal **50 Hz** set point. A response is requested when the absolute deviation reaches the configured threshold (default `0.2 Hz`). The backend calculates a load response, publishes an `ON`/`OFF` relay command, and records the delivered contribution.

- `POST /api/grid-services/frequency/readings` — `{ meterId, frequencyHz, loadKw, thresholdHz?, responseRatio? }`
- `POST /api/grid-services/frequency/contributions` — settle a response interval and calculate revenue
- `GET /api/grid-services/frequency/:meterId/summary` — contribution and revenue sharing summary
- `GET /api/grid-services/frequency/:meterId/events` — auditable `GridServiceProvided` records

The calculation is `response kW × duration hours = contribution kWh`; revenue is contribution kWh multiplied by the configured XLM/kWh rate. The event payload includes meter, frequency, response, duration, contribution, and revenue so it can be reported to a grid operator.

## Geofencing (Issue #1017)

- `POST /api/grid-services/geofences` registers the expected coordinates and radius.
- `POST /api/grid-services/geofences/verify` accepts periodic GPS reports.
- `GET /api/grid-services/geofences/:meterId` returns the last verification history and disabled status.

Distance uses the haversine formula. A report outside the registered radius emits a failed verification result and marks the meter disabled for fraud review. The geofence list is available to the frontend map at `GET /api/grid-services/geofences`.

Production deployments should persist this state in the platform database and require operator review before re-enabling a disabled meter.
