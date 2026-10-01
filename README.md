# ApplyMate

ApplyMate is a human-in-the-loop personal application agent. It collects application opportunities, keeps a reusable encrypted profile, fills repetitive web-form fields, surfaces unfamiliar questions, and requires the applicant to review everything and complete CAPTCHA before submission.

## Product components

- **Web dashboard:** account, encrypted trusted profile, application inbox, status tracking, Gmail discovery, audit history, data export, and account deletion.
- **Browser agent:** automatically syncs the encrypted dashboard profile, fills matching fields, highlights unanswered questions, learns approved new answers, and enforces a review/CAPTCHA confirmation gate.
- **Node service:** dependency-free HTTP API, SQLite persistence, salted scrypt password hashes, server-side sessions, AES-256-GCM encrypted profiles/provider tokens, CSRF origin checks, login throttling, security headers, and health checks.

ApplyMate never fills passwords, OTPs, CAPTCHA, financial details, signatures, consent, or demographic declarations. It does not silently submit a form.

## Run locally

Requirements: Node.js 24 or newer.

1. Copy `.env.example` to `.env`.
2. Generate an encryption key:

   ```sh
   node -e "console.log(require('crypto').randomBytes(32).toString('base64'))"
   ```

3. Put that key in `.env` as `APP_ENCRYPTION_KEY`.
4. Start the app with `npm start`.
5. Open `http://localhost:8787`.

Run validation with `npm run check` and `npm test`.

## Install the browser agent locally

1. Open `edge://extensions` in Microsoft Edge or `chrome://extensions` in Chrome.
2. Enable **Developer mode**.
3. Choose **Load unpacked** and select this repository folder.
4. In the web dashboard, open **Connections → Chrome extension** and create a pairing token.
5. Paste the dashboard URL and pairing token into the one-time browser-agent setup page, then select **Connect and sync profile**.
6. Open an application form. Known safe fields are filled automatically; unanswered fields are highlighted for you.
7. Review the form, complete CAPTCHA, and approve any new answers you want ApplyMate to remember before submission.

The popup and the on-page status card display the running agent version. After changing extension files, select **Reload** on the browser's Extensions page and confirm the displayed version before testing.

### Autofill engine

Version 0.3 separates semantic field matching from browser DOM control. It includes a dedicated LinkedIn Easy Apply adapter, React-compatible input updates, dynamic multi-step rescanning, employment-duration parsing, non-overwrite protection, and explicit reasons for fields that require the applicant. Reusable matching behavior is covered by automated tests.

Creating a new pairing token revokes the previous token.

## Gmail discovery

Set `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET`, and `GOOGLE_REDIRECT_URI` to enable Gmail. The redirect URI must end in `/api/integrations/google/callback` and exactly match the URI configured in Google Cloud.

The integration requests `gmail.readonly`, searches recent likely opportunity messages, extracts probable application links, and deduplicates them before inbox import. It cannot send, alter, or delete email. A public deployment requesting this restricted scope must complete Google's verification and security requirements.

## LinkedIn and WhatsApp

LinkedIn access is limited to user-shared URLs, notification email, and officially approved APIs. WhatsApp opportunities use explicit forward/share flows. ApplyMate deliberately does not scrape LinkedIn or personal WhatsApp sessions.

## Deployment

The repository includes a Dockerfile and Docker Compose configuration. See [DEPLOYMENT.md](./DEPLOYMENT.md) for secrets, persistent storage, TLS, backup, OAuth, and launch requirements.

## Important trust boundary

ApplyMate reduces repetitive work; it cannot guarantee that every site or answer is correct. The user remains responsible for checking truthfulness, eligibility, attachments, required fields, and the final application. CAPTCHA is always completed by the user and is never bypassed.
