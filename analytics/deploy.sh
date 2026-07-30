#!/usr/bin/env bash
# Deploy Overhead analytics collector to Cloud Run (europe-west1).
set -euo pipefail

PROJECT_ID="${PROJECT_ID:-overhead-analytics-260730}"
REGION="${REGION:-europe-west1}"
SERVICE="${SERVICE:-overhead-analytics}"
ROOT="$(cd "$(dirname "$0")" && pwd)"

echo "Deploying $SERVICE to $PROJECT_ID ($REGION)…"

# Allow Cloud Run runtime SA to read secrets + write BigQuery
PROJECT_NUMBER="$(gcloud projects describe "$PROJECT_ID" --format='value(projectNumber)' --verbosity=info)"
RUNTIME_SA="${PROJECT_NUMBER}-compute@developer.gserviceaccount.com"

gcloud secrets add-iam-policy-binding hmac-salt \
  --project="$PROJECT_ID" \
  --member="serviceAccount:${RUNTIME_SA}" \
  --role="roles/secretmanager.secretAccessor" \
  --verbosity=info

gcloud secrets add-iam-policy-binding dashboard-secret \
  --project="$PROJECT_ID" \
  --member="serviceAccount:${RUNTIME_SA}" \
  --role="roles/secretmanager.secretAccessor" \
  --verbosity=info

gcloud projects add-iam-policy-binding "$PROJECT_ID" \
  --member="serviceAccount:${RUNTIME_SA}" \
  --role="roles/bigquery.dataEditor" \
  --verbosity=info

gcloud projects add-iam-policy-binding "$PROJECT_ID" \
  --member="serviceAccount:${RUNTIME_SA}" \
  --role="roles/bigquery.jobUser" \
  --verbosity=info

gcloud run deploy "$SERVICE" \
  --project="$PROJECT_ID" \
  --region="$REGION" \
  --source="$ROOT" \
  --allow-unauthenticated \
  --min-instances=0 \
  --max-instances=3 \
  --cpu=1 \
  --memory=512Mi \
  --concurrency=80 \
  --timeout=60 \
  --set-env-vars="GCP_PROJECT=${PROJECT_ID},BQ_DATASET=overhead,BQ_TABLE=events" \
  --set-secrets="HMAC_SALT=hmac-salt:latest,DASHBOARD_SECRET=dashboard-secret:latest" \
  --verbosity=info

URL="$(gcloud run services describe "$SERVICE" --project="$PROJECT_ID" --region="$REGION" --format='value(status.url)' --verbosity=info)"
echo ""
echo "Collector:  ${URL}/collect"
echo "Dashboard:  ${URL}/dashboard"
echo "Health:     ${URL}/healthz"
