#!/usr/bin/env bash
# infra/provision-cloudsql.sh
# Run once to create the Cloud SQL Postgres 17 instance for CleanShot.
# Estimated time: 5-10 minutes for instance creation.
# Estimated cost: ~$25-50/month (db-f1-micro for dev, db-g1-small for prod).
#
# Prerequisites:
#   gcloud auth login
#   gcloud config set project cleanshot-493512

set -euo pipefail

PROJECT="cleanshot-493512"
REGION="us-central1"
INSTANCE_NAME="cleanshot-postgres"
DB_NAME="cleanshot"
DB_USER="cleanshot"
DB_PASSWORD=$(openssl rand -hex 24)   # Generated once — copy this to Secret Manager

echo "==> Creating Cloud SQL Postgres 17 instance..."
echo "    Instance: ${INSTANCE_NAME}"
echo "    Region:   ${REGION}"
echo "    This takes 5-10 minutes."

gcloud sql instances create "${INSTANCE_NAME}" \
  --project="${PROJECT}" \
  --database-version=POSTGRES_17 \
  --region="${REGION}" \
  --tier=db-g1-small \
  --storage-type=SSD \
  --storage-size=10GB \
  --storage-auto-increase \
  --backup \
  --backup-start-time=03:00 \
  --retained-backups-count=7 \
  --no-assign-ip \
  --network=default \
  --enable-google-private-path

# ^^^ --no-assign-ip + --network=default + --enable-google-private-path
# gives a private IP only — Cloud Run connects via private IP.
# No public internet exposure. Safer and cheaper (no Cloud SQL Auth Proxy needed
# for Cloud Run when using private IP + Direct VPC egress).

echo ""
echo "==> Creating database..."
gcloud sql databases create "${DB_NAME}" \
  --instance="${INSTANCE_NAME}" \
  --project="${PROJECT}"

echo ""
echo "==> Creating database user..."
gcloud sql users create "${DB_USER}" \
  --instance="${INSTANCE_NAME}" \
  --project="${PROJECT}" \
  --password="${DB_PASSWORD}"

echo ""
echo "==> Fetching private IP address..."
PRIVATE_IP=$(gcloud sql instances describe "${INSTANCE_NAME}" \
  --project="${PROJECT}" \
  --format="value(ipAddresses[0].ipAddress)")

echo ""
echo "============================================================"
echo "  Cloud SQL instance created successfully."
echo "============================================================"
echo ""
echo "  Instance name: ${INSTANCE_NAME}"
echo "  Private IP:    ${PRIVATE_IP}"
echo "  Database:      ${DB_NAME}"
echo "  User:          ${DB_USER}"
echo "  Password:      ${DB_PASSWORD}"
echo ""
echo "  DATABASE_URL (for Cloud Run --set-secrets):"
echo "  postgresql://${DB_USER}:${DB_PASSWORD}@${PRIVATE_IP}:5432/${DB_NAME}"
echo ""
echo "  DATABASE_URL (for local dev via Cloud SQL Auth Proxy):"
echo "  postgresql://${DB_USER}:${DB_PASSWORD}@127.0.0.1:5432/${DB_NAME}"
echo ""
echo "============================================================"
echo "  NEXT STEPS:"
echo "============================================================"
echo ""
echo "  1. Save DATABASE_URL to Secret Manager:"
echo "     echo -n 'postgresql://${DB_USER}:${DB_PASSWORD}@${PRIVATE_IP}:5432/${DB_NAME}' \\"
echo "       | gcloud secrets create cleanshot-database-url --data-file=- --project=${PROJECT}"
echo ""
echo "  2. Grant Cloud Run service account access to the secret:"
echo "     gcloud secrets add-iam-policy-binding cleanshot-database-url \\"
echo "       --member='serviceAccount:forklift-api@${PROJECT}.iam.gserviceaccount.com' \\"
echo "       --role='roles/secretmanager.secretAccessor' \\"
echo "       --project=${PROJECT}"
echo ""
echo "  3. Grant Cloud Run service account Cloud SQL Client role:"
echo "     gcloud projects add-iam-policy-binding ${PROJECT} \\"
echo "       --member='serviceAccount:forklift-api@${PROJECT}.iam.gserviceaccount.com' \\"
echo "       --role='roles/cloudsql.client'"
echo ""
echo "  4. For local development, connect via Cloud SQL Auth Proxy:"
echo "     cloud-sql-proxy ${PROJECT}:${REGION}:${INSTANCE_NAME} --port=5432"
echo "     (Install: https://cloud.google.com/sql/docs/postgres/sql-proxy)"
echo ""
echo "  5. Run schema migrations (first time only):"
echo "     cd apps/api"
echo "     ENVIRONMENT=local DATABASE_URL=<local proxy url> uvicorn cleanshot_api.main:app"
echo "     # Migrations run automatically on startup when ENVIRONMENT=local"
echo ""
echo "  ⚠️  SAVE THE PASSWORD ABOVE — it will not be shown again."
echo "      Store it in a password manager before closing this terminal."
