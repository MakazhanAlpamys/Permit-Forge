-- ============================================================================
-- D8/M15 — Functional index supporting find_chunks_by_section's LIKE patterns
-- ============================================================================
--
-- find_chunks_by_section runs three predicates on (metadata->>'section'):
--
--   1) d.metadata->>'section' = section_number
--   2) d.metadata->>'section' LIKE section_number || '.%'         (child)
--   3) section_number LIKE (d.metadata->>'section') || '.%'       (parent)
--
-- The existing idx_chunks_section is a default-collation b-tree over
-- (metadata->>'section'); it handles equality (1) but not the LIKE-with-
-- right-wildcard patterns (2) and (3) under non-C collations. A
-- text_pattern_ops index supports left-anchored LIKE regardless of
-- locale, so the planner can pick it for `'1.2.%'`-style predicates.
--
-- We keep the existing idx_chunks_section index for equality lookups
-- (cheaper than gin) and add a parallel text_pattern_ops one specifically
-- for the prefix LIKE branch.

CREATE INDEX IF NOT EXISTS idx_chunks_section_pattern
  ON dubai_code_chunks ((metadata->>'section') text_pattern_ops);
