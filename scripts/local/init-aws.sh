#!/usr/bin/env bash
# Creates the local resources the worker expects (docker-compose.yml runs this
# once, in an amazon/aws-cli container, before the worker starts):
#   - the S3 bucket
#   - the dead-letter queue
#   - the main queue (in AWS it is subscribed to the event-driven SNS topic)
#   - the priority queue (in AWS it has no SNS subscription; fed by `yarn queue --priority`)
# Both work queues redrive to the DLQ after MAX_RECEIVE_COUNT receives, like
# the queues definitions creates in AWS. Idempotent: safe to re-run.
set -euo pipefail

: "${SQS_ENDPOINT:?SQS_ENDPOINT is required}"
: "${S3_ENDPOINT:?S3_ENDPOINT is required}"
: "${BUCKET:?BUCKET is required}"
MAIN_QUEUE_NAME="${MAIN_QUEUE_NAME:-asset-optimizer-tasks}"
PRIORITY_QUEUE_NAME="${PRIORITY_QUEUE_NAME:-asset-optimizer-priority-tasks}"
DLQ_NAME="${DLQ_NAME:-asset-optimizer-tasks-dlq}"
MAX_RECEIVE_COUNT="${MAX_RECEIVE_COUNT:-6}"
VISIBILITY_TIMEOUT="${VISIBILITY_TIMEOUT:-900}"

# Emulators need path-style S3 addressing.
aws configure set default.s3.addressing_style path

sqs() { aws --endpoint-url "${SQS_ENDPOINT}" sqs "$@"; }
s3api() { aws --endpoint-url "${S3_ENDPOINT}" s3api "$@"; }

wait_for() {
  local name="$1"; shift
  for _ in $(seq 1 60); do
    if "$@" >/dev/null 2>&1; then
      echo "[init] ${name} is up"
      return 0
    fi
    sleep 1
  done
  echo "[init] FATAL: ${name} did not come up" >&2
  return 1
}

wait_for "SQS (${SQS_ENDPOINT})" sqs list-queues
wait_for "S3 (${S3_ENDPOINT})" s3api list-buckets

if s3api head-bucket --bucket "${BUCKET}" >/dev/null 2>&1; then
  echo "[init] bucket ${BUCKET} already exists"
else
  s3api create-bucket --bucket "${BUCKET}" >/dev/null
  echo "[init] created bucket ${BUCKET}"
fi

dlq_url="$(sqs create-queue --queue-name "${DLQ_NAME}" --query QueueUrl --output text)"
sqs set-queue-attributes --queue-url "${dlq_url}" --attributes MessageRetentionPeriod=1209600
dlq_arn="$(sqs get-queue-attributes --queue-url "${dlq_url}" --attribute-names QueueArn \
  --query Attributes.QueueArn --output text)"
echo "[init] dlq ${dlq_url} (${dlq_arn})"

attrs_file="$(mktemp)"
trap 'rm -f "${attrs_file}"' EXIT
cat > "${attrs_file}" <<JSON
{
  "VisibilityTimeout": "${VISIBILITY_TIMEOUT}",
  "MessageRetentionPeriod": "1209600",
  "RedrivePolicy": "{\"deadLetterTargetArn\":\"${dlq_arn}\",\"maxReceiveCount\":\"${MAX_RECEIVE_COUNT}\"}"
}
JSON

for name in "${MAIN_QUEUE_NAME}" "${PRIORITY_QUEUE_NAME}"; do
  url="$(sqs create-queue --queue-name "${name}" --query QueueUrl --output text)"
  sqs set-queue-attributes --queue-url "${url}" --attributes "file://${attrs_file}"
  echo "[init] queue ${url} -> redrive to ${DLQ_NAME} after ${MAX_RECEIVE_COUNT} receives"
done

echo "[init] done"
