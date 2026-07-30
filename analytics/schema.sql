-- Reference schema (already applied in europe-west1)
CREATE TABLE IF NOT EXISTS `overhead-analytics-260730.overhead.events` (
  event_id STRING NOT NULL,
  event_name STRING NOT NULL,
  received_at TIMESTAMP NOT NULL,
  client_id STRING,
  session_id STRING,
  visitor_id STRING,
  page_location STRING,
  page_title STRING,
  page_referrer STRING,
  utm_source STRING,
  utm_medium STRING,
  utm_campaign STRING,
  utm_content STRING,
  utm_term STRING,
  engagement_ms INT64,
  engaged BOOL,
  device STRING,
  browser STRING,
  os STRING,
  country STRING,
  event_params STRING
)
PARTITION BY DATE(received_at);
