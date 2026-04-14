# BitstringStatusListCredential Migration Guide

## Overview

After applying the fixes for the JWT issues (kid header, iss/sub quotes, Content-Type), existing status list credentials in cloud storage will retain their old format until they are re-published.

This guide provides instructions for customers to migrate their existing credentials.

---

## Option 1: Trigger Re-publication via API (Recommended)

The simplest approach is to trigger a status update for each credential status configuration. This will cause the system to re-sign and re-publish the status list credential with the corrected format.

### Using the Enterprise API

For each status configuration, make a status update call (even if the status doesn't change, this will re-publish):

```bash
# Example: Update a credential's status (this triggers re-publication)
curl -X POST "https://your-api.example.com/api/v1/status/{statusConfigRef}/update" \
  -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" \
  -d '{
    "session": "existing-session-id",
    "status": "0"
  }'
```

---

## Option 2: Manual Cloud Storage Migration

If you need to update the Content-Type header without re-issuing credentials, you can use cloud CLI tools.

### AWS S3

**Update Content-Type for all objects in a bucket:**

```bash
# List all objects and update their Content-Type
aws s3 ls s3://your-bucket-name/ --recursive | awk '{print $4}' | while read key; do
  echo "Updating Content-Type for: $key"
  aws s3 cp "s3://your-bucket-name/$key" "s3://your-bucket-name/$key" \
    --content-type "application/vc+jwt" \
    --metadata-directive REPLACE
done
```

**For a single object:**

```bash
aws s3 cp "s3://your-bucket-name/your-status-list-id" "s3://your-bucket-name/your-status-list-id" \
  --content-type "application/vc+jwt" \
  --metadata-directive REPLACE
```

**Note:** This only fixes the Content-Type header. The JWT payload issues (kid, iss/sub) require re-signing, which can only be done through the API.

### Google Cloud Storage (GCP)

**Update Content-Type for all objects:**

```bash
# List and update all objects
gsutil ls gs://your-bucket-name/ | while read uri; do
  echo "Updating Content-Type for: $uri"
  gsutil setmeta -h "Content-Type:application/vc+jwt" "$uri"
done
```

**For a single object:**

```bash
gsutil setmeta -h "Content-Type:application/vc+jwt" gs://your-bucket-name/your-status-list-id
```

### Azure Blob Storage

**Update Content-Type for all blobs:**

```bash
# List all blobs and update their Content-Type
az storage blob list --container-name your-container --account-name your-account --query "[].name" -o tsv | while read blob; do
  echo "Updating Content-Type for: $blob"
  az storage blob update \
    --container-name your-container \
    --account-name your-account \
    --name "$blob" \
    --content-type "application/vc+jwt"
done
```

**For a single blob:**

```bash
az storage blob update \
  --container-name your-container \
  --account-name your-account \
  --name your-status-list-id \
  --content-type "application/vc+jwt"
```

---