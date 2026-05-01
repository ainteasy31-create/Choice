-- Add all missing columns to pipeline.pipeline_scrape_runs
  -- These columns were referenced in code but missing from the table,
  -- causing silent failures when logging scrape runs.
  ALTER TABLE pipeline.pipeline_scrape_runs
    ADD COLUMN IF NOT EXISTS count_duplicate           integer NOT NULL DEFAULT 0,
    ADD COLUMN IF NOT EXISTS count_watermarked         integer NOT NULL DEFAULT 0,
    ADD COLUMN IF NOT EXISTS count_validation_rejected integer NOT NULL DEFAULT 0,
    ADD COLUMN IF NOT EXISTS count_image_failed        integer NOT NULL DEFAULT 0,
    ADD COLUMN IF NOT EXISTS meta_json                 text,
    ADD COLUMN IF NOT EXISTS idempotency_key           text,
    ADD COLUMN IF NOT EXISTS partial                   boolean NOT NULL DEFAULT false;
  