-- Add missing count_duplicate column to pipeline_scrape_runs
  -- This column tracks how many scraped rows were skipped as duplicates per run.
  ALTER TABLE pipeline.pipeline_scrape_runs
    ADD COLUMN IF NOT EXISTS count_duplicate integer NOT NULL DEFAULT 0;
  