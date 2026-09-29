# ApplyMate deployment

## What is deployable now

The web service includes account registration, password-based authentication, login throttling, server-side sessions, encrypted profile and provider-token storage, a deduplicated application inbox, Gmail discovery, an audit trail, account export/deletion, security headers, health checks, and a responsive dashboard. The Chrome extension remains unpacked during development and can later be packaged for Chrome Web Store review.

The dashboard can issue one revocable Chrome-extension device token. In the extension profile page, enter the deployed dashboard URL and that token, then use **Test and sync profile**. Creating a new token invalidates the previous token.

## Required production configuration

1. Use a host that supports a persistent volume. SQLite must not live on an ephemeral filesystem.
2. Generate a unique encryption key:

   ```sh
   node -e "console.log(require('crypto').randomBytes(32).toString('base64'))"
   ```

3. Set `APP_ENCRYPTION_KEY` to that value and store it in the host's secret manager. Losing it makes encrypted profiles unrecoverable. Never rotate it without a migration.
4. Set `APP_ORIGIN` to the exact HTTPS public origin, with no trailing slash.
5. Mount persistent storage at `/data` and deploy the included Dockerfile.
6. Configure TLS at the hosting platform or reverse proxy. Production session cookies are marked `Secure`.
7. Back up both the SQLite database and encryption key separately.
8. Replace the operator placeholders in `public/privacy.html` and `public/terms.html` after legal review.

## Gmail configuration

Create a Google OAuth web client and set:

- `GOOGLE_CLIENT_ID`
- `GOOGLE_CLIENT_SECRET`
- `GOOGLE_REDIRECT_URI=https://your-domain.example/api/integrations/google/callback`

The same redirect URI must be registered in Google Cloud. The integration requests only `gmail.readonly`, but that is a restricted scope and requires Google's verification process before a public launch. Provider access and refresh credentials are encrypted in the database.

## Local production-like run

Create a `.env` based on `.env.example`, then run:

```sh
npm start
```

Visit `http://localhost:8787`. The health endpoint is `/healthz`.

For Docker Compose, export `APP_ENCRYPTION_KEY` in your shell and run `docker compose up --build`.

## Before public launch

- Add email verification, password reset, and optional MFA.
- Put the service behind a managed HTTPS proxy and rate limiter.
- Use a managed PostgreSQL database before multi-instance scaling.
- Complete an independent security review and finalize the privacy, terms, and backup-retention language.
- Complete Google verification before requesting restricted Gmail scopes.
- Package and review the extension with the narrowest possible host permissions.
- Add automated browser compatibility tests for supported application portals.

## Integration boundary

Gmail is implemented but requires OAuth credentials owned by the deployment. Outlook remains planned. LinkedIn access is limited to officially approved APIs, notification email, and user-shared links. WhatsApp personal chats and channels must not be scraped; use an explicit share/forward flow.
