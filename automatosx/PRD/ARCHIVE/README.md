# ARCHIVE - Superseded Documents

**Status:** Historical Reference Only
**Date Archived:** 2025-11-07

---

## ⚠️ IMPORTANT

**These documents are SUPERSEDED and should NOT be used for planning or implementation.**

All content from these documents has been:
- Reviewed and consolidated
- Updated with Phase 0 results
- Merged into final versions

---

## Archived Documents

### 1. mlx-serving-prd.md (v0.2)
**Superseded By:** `../PRD-FINAL.md` (v1.0)
**Reason:** Consolidated and updated with Phase 0 validation results
**Date Archived:** 2025-11-07

**What Changed:**
- Added Phase 0 completion status
- Updated baseline validation results (331 tests passing)
- Clarified source foundation (kr-serve-mlx with native module)
- Consolidated architecture details
- Updated technology stack with validated versions
- Enhanced testing strategy

### 2. mlx-serving-implementation-plan.md (v0.2)
**Superseded By:** `../ACTION-PLAN-FINAL.md` (v1.0)
**Reason:** Detailed with actual Phase 0 results and ready-to-execute Phase 1 tasks
**Date Archived:** 2025-11-07

**What Changed:**
- Added complete Phase 0 summary with results
- Detailed Phase 1 tasks with specific file paths
- Updated timelines based on actual Phase 0 completion
- Added risk mitigations based on lessons learned
- Included file change matrix for each phase

### 3. mlx-serving-architecture-analysis.md (v0.1)
**Superseded By:** Content merged into `../PRD-FINAL.md` (Section 6)
**Reason:** Architecture details integrated into main PRD
**Date Archived:** 2025-11-07

**What Changed:**
- Architecture section now part of PRD (better structure)
- Native module details extracted to NATIVE_MODULE_ANALYSIS.md
- Zod adoption targets incorporated into Phase 1 plan
- ReScript strategy incorporated into Phase 2 plan

### 4. PROJECT_SUMMARY.md (v0.1)
**Superseded By:** Content merged into `../PRD-FINAL.md` (Sections 1-2)
**Reason:** Executive summary now part of main PRD
**Date Archived:** 2025-11-07

**What Changed:**
- Executive summary improved and consolidated
- Phase information updated with actual results
- Technology stack validated and detailed
- Implementation phases refined

---

## Why These Were Archived

**Consolidation:** Multiple documents created confusion about "single source of truth"

**Validation:** Phase 0 completion provided real data that superseded estimates

**Clarity:** Final versions are more concise, better structured, and easier to follow

**Accuracy:** Old versions had assumptions that proved incorrect (e.g., Zod not installed → Zod already installed)

---

## Should I Ever Use These?

**For Planning/Implementation:** ❌ NO - Use `../PRD-FINAL.md` and `../ACTION-PLAN-FINAL.md`

**For Historical Context:** ✅ YES - To understand how decisions evolved

**For Reference:** ⚠️ MAYBE - But verify with current documents first

---

## Migration Map

If you were using:

| Old Document | Use Instead |
|-------------|-------------|
| `mlx-serving-prd.md` | `../PRD-FINAL.md` |
| `mlx-serving-implementation-plan.md` | `../ACTION-PLAN-FINAL.md` |
| Architecture analysis | `../PRD-FINAL.md` (Section 6) |
| Project summary | `../PRD-FINAL.md` (Sections 1-2) |
| Native module info | `../NATIVE_MODULE_ANALYSIS.md` |

---

## Version History

These documents went through the following versions before archival:

1. **v0.1** (2025-11-07): Initial drafts from AutomatosX agents
2. **v0.2** (2025-11-07): Updated with codebase analysis
3. **v1.0** (2025-11-07): Final consolidated versions (CURRENT)

Archived versions: v0.1 - v0.2

---

**Last Updated:** 2025-11-07
**Archive Status:** Permanent (Historical Reference)
