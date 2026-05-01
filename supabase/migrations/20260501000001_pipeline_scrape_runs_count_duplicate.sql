-- Migration: add count_duplicate column to pipeline.pipeline_scrape_runs
  -- This column was referenced in scraper.py but missing from the table,
  -- causing a silent PGRST204 error on every scrape run log write.

  ALTER TABLE pipeline.pipeline_scrape_runs
    ADD COLUMN IF NOT EXISTS count_duplicate integer NOT NULL DEFAULT 0;
  