# Chapter Outline Batch Contracts

This note records the reusable contract surface for the chapter-outline batch work.

## Existing Contracts To Reuse

- `outline-character-contracts.ts`
  - `assertVolumeCharacterPlan` validates volume-level `characterPlan`.
  - `assertChapterCharacterExecution` validates `characterExecution.cast`, source whitelist membership, `minor_temporary` declarations, scene participants, relationship participants, and action/scene references.
- `story-unit-contracts.ts`
  - `assertVolumeStoryUnitPlan` validates `storyUnitPlan.chapterAllocation` and chapter coverage when a chapter count is provided.
  - `storyUnitForChapter` resolves the upstream story unit for a chapter.
- `generate-outline-preview.tool.ts`
  - `OutlinePreviewOutput` and `ChapterCraftBrief` are the downstream-compatible output shape used by `validate_outline` and `persist_outline`.

## New Shared Helper

- `chapter-outline-batch-contracts.ts`
  - `assertChapterRangeCoverage` validates batch range coverage for `1..chapterCount`.
  - It fails on missing chapters, overlaps, non-continuous ranges, invalid ranges, and out-of-range chapters.
  - It is intentionally structural only. It must never synthesize chapter titles, objectives, outlines, `craftBrief`, character execution, or story content.

## Quality Boundary

Batch segmentation, batch preview normalization, and batch merging may only split ranges, select context, validate structure, combine already-generated chapters, and report errors. If a chapter, `craftBrief`, required field, story unit link, or character source is missing or invalid after allowed LLM repair, the tool must fail rather than filling deterministic content.
