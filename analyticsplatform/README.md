# Analytics platform

Consent-gated, first-party analytics shared by multiple projects. A Cloud Run collector
writes events to a partitioned BigQuery table; a secret-protected dashboard reports
unique and total page viewers and clickers by project.

Currently registered projects:

- `overhead` - the satellite project
- `detentioncenters` - the immigration detention map and bond release fund

## Privacy model

Clients send nothing before consent. The collector derives country and a rotating daily
visitor hash from the request IP in memory, then discards the IP. Event parameters are
limited to short strings, numbers, and booleans. Clients must not send search text,
precise location, confidential case data, authentication values, or payment data.

## Add a project

1. Add the project ID to `ALLOWED_SITE_IDS` when deploying.
2. Initialize the client with the same `siteId` and collector URL.
3. Add the site's production and local origins to `ALLOWED_ORIGINS` when necessary.
4. Publish a privacy notice and require consent before sending events.

Project IDs contain lowercase letters, numbers, `_`, or `-`, and are stored in the
`site_id` BigQuery column. Existing rows without a site ID are reported as `overhead`.

## Deploy

```bash
./deploy.sh
```

The deploy script adds the nullable `site_id` column when upgrading an existing table,
then deploys the collector and dashboard to the current Cloud Run service. Runtime HMAC
and dashboard secrets remain in Google Secret Manager.
