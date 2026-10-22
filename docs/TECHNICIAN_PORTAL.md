# Technician Portal

The Technician Portal gives field technicians a dedicated, mobile-first workspace for
installations and maintenance. It covers the backend technician/work-order management
APIs, a mobile-optimized web portal at `/technician`, QR code scanning for meter
registration, and photo upload for installation verification.

## Overview

- **Backend**: Technician and work-order management, assignments, status transitions,
  photo storage, and QR-based meter registration.
- **Frontend**: A mobile-optimized portal served at `/technician`.
- **Mobile**: Touch-friendly layouts, large tap targets, camera access for QR scanning
  and photo capture.

## Data Model

### Technician

| Field       | Type     | Description                                        |
| ----------- | -------- | -------------------------------------------------- |
| `id`        | string   | Unique technician identifier                       |
| `name`      | string   | Full name                                          |
| `email`     | string   | Contact email                                      |
| `phone`     | string   | Contact phone number                               |
| `status`    | string   | `active`, `inactive`, or `on_leave`                |
| `skills`    | string[] | Skill tags (e.g. `installation`, `maintenance`)    |
| `createdAt` | string   | ISO 8601 creation timestamp                        |
| `updatedAt` | string   | ISO 8601 last-update timestamp                     |

### WorkOrder

| Field          | Type     | Description                                              |
| -------------- | -------- | -------------------------------------------------------- |
| `id`           | string   | Unique work-order identifier                             |
| `title`        | string   | Short summary of the task                                |
| `description`  | string   | Detailed instructions                                    |
| `type`         | string   | `installation`, `maintenance`, or `repair`               |
| `status`       | string   | `pending`, `assigned`, `in_progress`, `completed`, `cancelled` |
| `priority`     | string   | `low`, `medium`, or `high`                               |
| `technicianId` | string   | Assigned technician (`null` when unassigned)             |
| `customerId`   | string   | Related customer identifier                              |
| `address`      | string   | Service location                                         |
| `scheduledAt`  | string   | ISO 8601 scheduled start time                            |
| `completedAt`  | string   | ISO 8601 completion time (`null` until complete)         |
| `notes`        | string   | Technician notes                                         |
| `photos`       | Photo[]  | Installation-verification photos                         |
| `createdAt`    | string   | ISO 8601 creation timestamp                              |
| `updatedAt`    | string   | ISO 8601 last-update timestamp                           |

### Assignment

Assignments link technicians to work orders. An assignment is created when a work
order is created with a `technicianId`, or when a work order is reassigned.

| Field          | Type   | Description                                  |
| -------------- | ------ | -------------------------------------------- |
| `id`           | string | Unique assignment identifier                  |
| `workOrderId`  | string | Related work order                            |
| `technicianId` | string | Assigned technician                           |
| `assignedAt`   | string | ISO 8601 assignment timestamp                 |
| `assignedBy`   | string | User who created the assignment               |

### Photo

| Field         | Type   | Description                                       |
| ------------- | ------ | ------------------------------------------------- |
| `id`          | string | Unique photo identifier                           |
| `workOrderId` | string | Related work order                                |
| `url`         | string | Public URL of the stored image                    |
| `caption`     | string | Optional caption                                  |
| `uploadedAt`  | string | ISO 8601 upload timestamp                         |

## REST API

All endpoints are JSON-based. Authenticated requests must include a valid session or
bearer token. Errors use standard HTTP status codes and a JSON body:

```json
{ "error": "Work order not found" }
```

### `POST /api/work-orders`

Create a new work order. Optionally assigns it to a technician immediately.

**Request**

```http
POST /api/work-orders
Content-Type: application/json

{
  "title": "Install smart meter",
  "description": "Install and register a new smart meter at the customer site.",
  "type": "installation",
  "priority": "high",
  "technicianId": "tech-1024",
  "customerId": "cust-88",
  "address": "12 Oak Street, Springfield",
  "scheduledAt": "2024-06-01T09:00:00Z"
}
```

**Response** `201 Created`

```json
{
  "id": "wo-5001",
  "title": "Install smart meter",
  "description": "Install and register a new smart meter at the customer site.",
  "type": "installation",
  "status": "assigned",
  "priority": "high",
  "technicianId": "tech-1024",
  "customerId": "cust-88",
  "address": "12 Oak Street, Springfield",
  "scheduledAt": "2024-06-01T09:00:00Z",
  "completedAt": null,
  "notes": "",
  "photos": [],
  "createdAt": "2024-05-28T14:22:10Z",
  "updatedAt": "2024-05-28T14:22:10Z"
}
```

### `GET /api/work-orders/assigned/:techId`

List all work orders assigned to a technician. Supports optional query parameters:

- `status` — filter by status (e.g. `pending`, `in_progress`, `completed`)
- `from` / `to` — filter by `scheduledAt` range (ISO 8601)

**Request**

```http
GET /api/work-orders/assigned/tech-1024?status=assigned
```

**Response** `200 OK`

```json
{
  "technicianId": "tech-1024",
  "count": 1,
  "workOrders": [
    {
      "id": "wo-5001",
      "title": "Install smart meter",
      "type": "installation",
      "status": "assigned",
      "priority": "high",
      "address": "12 Oak Street, Springfield",
      "scheduledAt": "2024-06-01T09:00:00Z",
      "completedAt": null,
      "photos": []
    }
  ]
}
```

### `PATCH /api/work-orders/:id/complete`

Mark a work order as complete. Records the completion timestamp and optional
technician notes.

**Request**

```http
PATCH /api/work-orders/wo-5001/complete
Content-Type: application/json

{
  "notes": "Meter installed and registered successfully.",
  "completedAt": "2024-06-01T10:45:00Z"
}
```

**Response** `200 OK`

```json
{
  "id": "wo-5001",
  "status": "completed",
  "completedAt": "2024-06-01T10:45:00Z",
  "notes": "Meter installed and registered successfully.",
  "updatedAt": "2024-06-01T10:45:02Z"
}
```

### `POST /api/work-orders/:id/photos`

Upload an installation-verification photo for a work order. Requests use
`multipart/form-data` with a single `photo` file field and an optional `caption`.

**Request**

```http
POST /api/work-orders/wo-5001/photos
Content-Type: multipart/form-data; boundary=----WebKitFormBoundary

------WebKitFormBoundary
Content-Disposition: form-data; name="caption"

Meter faceplate after installation
------WebKitFormBoundary
Content-Disposition: form-data; name="photo"; filename="meter.jpg"
Content-Type: image/jpeg

<binary image data>
------WebKitFormBoundary--
```

**Response** `201 Created`

```json
{
  "id": "photo-9001",
  "workOrderId": "wo-5001",
  "url": "https://cdn.example.com/work-orders/wo-5001/meter.jpg",
  "caption": "Meter faceplate after installation",
  "uploadedAt": "2024-06-01T10:40:00Z"
}
```

## Mobile-Optimized Portal (`/technician`)

The portal is served at `/technician` and is designed mobile-first:

- **Responsive layout** — single-column card layout on phones, multi-column on
  tablets and desktops.
- **Large tap targets** — buttons and list rows sized for touch.
- **Bottom navigation** — quick access to *My Tasks*, *Scan*, and *Profile*.
- **Offline-friendly** — work orders are cached so technicians can view tasks
  without connectivity; uploads queue and retry when back online.
- **Camera integration** — direct access to the device camera for QR scanning and
  photo capture.

### My Tasks

Lists work orders assigned to the signed-in technician, grouped by status
(`assigned`, `in_progress`, `completed`). Tapping a task opens the detail view with
address, schedule, customer info, and action buttons.

### Task Detail

- **Start** — moves the work order to `in_progress`.
- **Scan meter** — opens the QR scanner to register a meter.
- **Add photo** — captures an installation-verification photo.
- **Complete** — marks the work order complete and submits notes.

## QR Code Scanning for Meter Registration

Technicians register meters by scanning the QR code printed on the meter.

1. Open a work order and tap **Scan meter**.
2. Grant camera permission when prompted.
3. Point the camera at the meter's QR code.
4. The portal decodes the payload (meter serial number and model) and submits it to
   register the meter against the work order.
5. On success, the meter is linked to the work order and customer, and the task
   detail view shows the registered meter.

**Example decoded QR payload**

```json
{
  "serialNumber": "MTR-4471-8823",
  "model": "SM-200",
  "manufacturer": "Acme Meters"
}
```

If the code cannot be decoded or the meter is already registered, the portal shows an
inline error and lets the technician retry.

## Photo Upload for Installation Verification

Photos provide visual proof of installation.

1. Open a work order and tap **Add photo**.
2. Capture a photo with the device camera or choose one from the gallery.
3. Optionally add a caption.
4. The portal uploads the image to `POST /api/work-orders/:id/photos` and displays a
   thumbnail in the task detail view.

Uploaded photos are attached to the work order and included in the `photos` array.
Images are validated for type (`image/jpeg`, `image/png`) and size (max 10 MB).

## Testing

Work-order management is covered by automated tests, including:

- Creating a work order with and without an assigned technician.
- Listing work orders for a technician, with status and date filters.
- Marking a work order complete and recording notes.
- Uploading a photo and validating type/size limits.
- Registering a meter via a scanned QR payload.

## Related Documentation

- [API Reference](./API.md)
- [Authentication](./AUTH.md)
- [Deployment](./DEPLOYMENT.md)