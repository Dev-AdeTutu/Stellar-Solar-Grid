# White-Label Provider Customization (#1005)

Stellar Solar Grid supports multi-tenant white-label branding so energy providers can customize the web portal, transactional emails, custom domains, and mobile app builds with their own brand identity.

## Database Schema

Provider branding configurations are stored in the `provider_branding` SQLite table:

- `provider_id` (Primary Key)
- `brand_name`
- `logo_url`
- `primary_color`, `secondary_color`, `accent_color`
- `custom_domain` (Unique index for custom domain resolution)
- `support_email`, `footer_text`
- `mobile_app_bundle_id`
- `updated_at`

## REST API Endpoints

- `POST /api/providers/:id/branding`: Uploads or updates a provider's branding configuration.
- `GET /api/providers/:id/branding`: Retrieves branding configuration by provider ID.
- `GET /api/providers/by-domain/:domain`: Resolves branding configuration dynamically from the request hostname.
- `GET /api/providers/:id/branding/mobile-config`: Generates white-label Expo/Capacitor mobile build configuration (`ios.bundleIdentifier`, `android.package`, icons, and theme colors).
- `POST /api/providers/:id/branding/email-preview`: Renders HTML email templates styled with the provider's logo and colors.

## Frontend Dynamic Theme Loading

The frontend `src/lib/branding.ts` module provides `fetchProviderBranding()` and `applyDynamicBrandingTheme()` to load tenant branding by provider ID or custom domain and inject `--color-brand-primary`, `--color-brand-secondary`, and `--color-brand-accent` CSS variables at runtime.
