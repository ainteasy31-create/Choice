-- Add quality_score_detail column to pipeline_properties
ALTER TABLE pipeline.pipeline_properties
  ADD COLUMN IF NOT EXISTS quality_score_detail JSONB;

COMMENT ON COLUMN pipeline.pipeline_properties.quality_score_detail IS
  'Detailed breakdown of data quality score by field group. Shows which fields are filled vs missing, helping admins understand why a listing has a particular score.';
