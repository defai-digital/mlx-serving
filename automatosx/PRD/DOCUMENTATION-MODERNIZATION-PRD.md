# Documentation Modernization PRD

**Project**: mlx-serving
**Document Type**: Product Requirements Document (PRD)
**Version**: 1.0
**Date**: 2025-11-10
**Status**: ✅ APPROVED FOR IMPLEMENTATION
**Owner**: Documentation Team

---

## Executive Summary

The mlx-serving documentation is **critically out of sync** with the codebase. After completing Week 7 optimizations and Phases 2-5, the documentation still reflects outdated information from Week 3, claims technologies not in use (ReScript), uses wrong project names (kr-serve-mlx), and is missing critical production features.

**Impact**: Users cannot discover or use advanced features. New developers receive misleading information. Project appears less mature than reality.

**Solution**: Comprehensive documentation modernization across all user-facing and developer documents.

---

## Problem Statement

### Critical Issues

1. **Wrong Technology Stack**: Claims "ReScript state management" - not used in codebase
2. **Wrong Project Name**: Uses "kr-serve-mlx" instead of "mlx-serving" throughout
3. **Version Mismatch**: Claims v0.11.0-alpha.1, actual v0.8.0
4. **Missing Features**: Week 7 optimizations (model preloading, object pooling, adaptive batching) undocumented
5. **Missing Production Features**: Phase 2-5 features (TTFT, QoS, canary deployment) undocumented
6. **Outdated Metrics**: Test counts and status information from 13+ days ago

### Impact Assessment

| Stakeholder | Impact | Severity |
|------------|--------|----------|
| New Users | Cannot discover advanced features | HIGH |
| Enterprise Customers | Unaware of production features (QoS, canary) | CRITICAL |
| Contributors | Receive incorrect development instructions | HIGH |
| Support Team | Cannot reference accurate documentation | HIGH |
| Marketing | Cannot accurately represent capabilities | MEDIUM |

---

## Goals & Objectives

### Primary Goals

1. **Accuracy**: All documentation reflects actual codebase reality
2. **Completeness**: All implemented features documented
3. **Consistency**: Unified branding, versioning, and terminology
4. **Discoverability**: Users can find and understand all features

### Success Metrics

- ✅ 100% feature coverage (Week 7 + Phases 2-5)
- ✅ Zero branding inconsistencies (kr-serve-mlx → mlx-serving)
- ✅ Correct version numbers across all files
- ✅ Updated within 7 days of implementation
- ✅ User feedback: "Easy to find what I need"

---

## Scope

### In Scope

#### Phase 1: Critical Fixes (Must Have)
1. README.md - Homepage fixes
   - Remove "ReScript" claims
   - Fix project name (kr-serve-mlx → mlx-serving)
   - Update version (0.11.0-alpha.1 → 0.8.0)
   - Update current phase (Week 3 → Week 7)
   - Fix test statistics

2. docs/INDEX.md - Documentation hub fixes
   - Fix project naming throughout
   - Update dates and statistics
   - Fix organization branding

3. CLAUDE.md - Developer instructions
   - Verify accuracy post-Week 7
   - Add optimization features

#### Phase 2: Feature Documentation (Should Have)
4. Week 7 Optimizations Guide
   - Model preloading configuration
   - Object pooling usage
   - Adaptive batching setup

5. Phase 2-5 Features Guide
   - TTFT pipeline documentation
   - QoS monitoring setup
   - Canary deployment guide
   - Feature flags configuration

6. Updated Architecture Documentation
   - Add Week 7 components diagram
   - Add Phase 2-5 architecture
   - Update technology stack

#### Phase 3: Polish (Nice to Have)
7. Example Code Updates
   - Week 7 optimization examples
   - Production feature examples

8. API Reference Updates
   - New interfaces/classes
   - Configuration options

### Out of Scope

- Rewriting existing correct documentation
- Translating to other languages
- Video tutorials
- Interactive demos

---

## Requirements

### Functional Requirements

#### FR-1: Branding Consistency
- **ID**: FR-1
- **Priority**: P0 (Critical)
- **Description**: All references to "kr-serve-mlx" must be changed to "mlx-serving"
- **Files Affected**: README.md, docs/INDEX.md, docs/*.md, package.json
- **Acceptance Criteria**:
  - Zero instances of "kr-serve-mlx" remain
  - Zero instances of "KnowRAG Studio" remain
  - Package name remains @knowrag/mlx-serving (OK for now)

#### FR-2: Technology Stack Accuracy
- **ID**: FR-2
- **Priority**: P0 (Critical)
- **Description**: Remove all false technology claims
- **Files Affected**: README.md, docs/ARCHITECTURE.md
- **Acceptance Criteria**:
  - Zero references to "ReScript"
  - Accurate technology list: TypeScript, Python, MLX, Metal

#### FR-3: Version Number Accuracy
- **ID**: FR-3
- **Priority**: P0 (Critical)
- **Description**: All version numbers must match package.json
- **Files Affected**: README.md, docs/INDEX.md, CHANGELOG.md
- **Acceptance Criteria**:
  - Version matches package.json across all docs
  - Status reflects actual implementation phase

#### FR-4: Week 7 Documentation
- **ID**: FR-4
- **Priority**: P1 (High)
- **Description**: Document all Week 7 performance optimizations
- **Deliverables**:
  - Model Preloading Guide (config/runtime.yaml reference)
  - Object Pooling API documentation
  - Adaptive Batching configuration guide
- **Acceptance Criteria**:
  - Users can enable/configure each feature
  - Performance benefits clearly stated
  - Configuration examples provided

#### FR-5: Phase 2-5 Documentation
- **ID**: FR-5
- **Priority**: P1 (High)
- **Description**: Document production-grade features
- **Deliverables**:
  - TTFT Pipeline Guide
  - QoS Monitoring Setup
  - Canary Deployment Guide
  - Feature Flags Reference
- **Acceptance Criteria**:
  - Enterprise users can enable production features
  - Configuration files documented
  - Deployment scripts explained

#### FR-6: Test Statistics Accuracy
- **ID**: FR-6
- **Priority**: P2 (Medium)
- **Description**: Update test counts and coverage numbers
- **Files Affected**: README.md, docs/INDEX.md
- **Acceptance Criteria**:
  - Test numbers reflect latest `npm test` output
  - Coverage percentages accurate

### Non-Functional Requirements

#### NFR-1: Maintainability
- Documentation updates automated where possible
- Version numbers pulled from package.json
- Test statistics generated from CI/CD

#### NFR-2: Consistency
- Unified formatting across all markdown files
- Consistent terminology (e.g., "model preloading" not "model pre-loading")
- Consistent code examples (TypeScript, not JS)

#### NFR-3: Discoverability
- All features listed in docs/INDEX.md
- Search-friendly headings
- Clear navigation structure

---

## Technical Architecture

### Documentation Structure (Target State)

```
docs/
├── INDEX.md                    # ✅ Entry point, feature catalog
├── README.md (root)            # ✅ Project homepage
├── QUICK_START.md              # 🆕 New: 5-minute getting started
├── ARCHITECTURE.md             # ✏️ Update: Add Week 7 + Phases 2-5
├── GUIDES.md                   # ✏️ Update: Add optimization guides
├── ZOD_SCHEMAS.md              # ✅ Already complete
├── DEPLOYMENT.md               # ✏️ Update: Add canary deployment
├── PERFORMANCE.md              # 🆕 New: Week 7 optimizations
├── PRODUCTION_FEATURES.md      # 🆕 New: QoS, TTFT, canary
├── FEATURE_FLAGS.md            # 🆕 New: Feature flag system
├── TESTING.md                  # ✅ Already complete
└── TROUBLESHOOTING.md          # 🆕 New: Common issues
```

**Legend**:
- ✅ Complete, no changes needed
- ✏️ Needs updates
- 🆕 New file to create

### Content Sources

| Doc Section | Source of Truth |
|-------------|----------------|
| Version | package.json `version` |
| Test Stats | CI/CD output or latest `npm test` |
| Features | Implementation code (src/, python/) |
| Config | config/runtime.yaml, config/feature-flags.yaml |
| Examples | examples/ directory |

---

## User Stories

### US-1: New User Discovery
**As a** new user
**I want to** quickly understand what mlx-serving can do
**So that** I can decide if it fits my needs

**Acceptance Criteria**:
- README.md lists all major features
- Performance optimizations highlighted
- Production features visible

### US-2: Performance Optimization
**As a** developer optimizing performance
**I want to** learn about Week 7 optimizations
**So that** I can enable them in my application

**Acceptance Criteria**:
- Model preloading guide exists
- Object pooling API documented
- Adaptive batching configuration clear

### US-3: Enterprise Deployment
**As an** enterprise architect
**I want to** understand production features (QoS, canary)
**So that** I can deploy with confidence

**Acceptance Criteria**:
- QoS monitoring setup documented
- Canary deployment guide exists
- Feature flags explained

### US-4: Contributor Onboarding
**As a** new contributor
**I want** accurate development instructions
**So that** I can contribute effectively

**Acceptance Criteria**:
- CLAUDE.md reflects current codebase
- Technology stack accurate
- Development workflow clear

---

## Implementation Plan

See **DOCUMENTATION-MODERNIZATION-ACTION-PLAN.md** for detailed implementation steps.

**Summary**:
1. Phase 1: Critical Fixes (2-3 days)
2. Phase 2: Feature Documentation (3-4 days)
3. Phase 3: Polish & Examples (2-3 days)

**Total Estimated Time**: 7-10 days

---

## Dependencies

- ✅ Week 7 implementation complete
- ✅ Phases 2-5 implementation complete
- ✅ `npm test` passing
- ⏳ Stan agent audit (in progress)
- ⏳ Final test statistics

---

## Risks & Mitigation

| Risk | Probability | Impact | Mitigation |
|------|-------------|---------|------------|
| Documentation drift during updates | HIGH | MEDIUM | Implement automated version/stats sync |
| Missing features discovered | MEDIUM | HIGH | Stan agent comprehensive audit |
| Breaking changes to examples | LOW | MEDIUM | Test all examples during updates |
| User confusion during transition | LOW | MEDIUM | Gradual rollout, preserve URLs |

---

## Success Criteria

### Definition of Done

- [x] Preliminary audit complete
- [ ] Stan comprehensive audit complete
- [ ] Action plan approved
- [ ] All P0 (Critical) fixes implemented
- [ ] All P1 (High) documentation written
- [ ] Examples tested and verified
- [ ] Internal review passed
- [ ] User testing feedback incorporated

### Launch Checklist

- [ ] README.md updated
- [ ] docs/ updated
- [ ] CLAUDE.md updated
- [ ] Examples verified
- [ ] CHANGELOG.md entry added
- [ ] Git commit created
- [ ] Optional: npm version bump (if releasing)

---

## Timeline

| Phase | Duration | Start | End |
|-------|----------|-------|-----|
| Audit | 1 day | 2025-11-10 | 2025-11-10 |
| Phase 1: Critical | 2-3 days | 2025-11-11 | 2025-11-13 |
| Phase 2: Features | 3-4 days | 2025-11-14 | 2025-11-17 |
| Phase 3: Polish | 2-3 days | 2025-11-18 | 2025-11-20 |
| **Total** | **8-11 days** | **2025-11-10** | **2025-11-20** |

---

## Appendix

### Audit Findings Reference

See: `automatosx/tmp/DOCUMENTATION-AUDIT-PRELIMINARY.md`

### Related Documents

- DOCUMENTATION-MODERNIZATION-ACTION-PLAN.md (implementation details)
- WEEK7_FINAL_COMPLETION_REPORT.md (features to document)
- automatosx/tmp/FINAL-COMPLETION-REPORT.md (Phases 2-5 features)

---

**Document Version**: 1.0
**Status**: APPROVED
**Next Review**: After Phase 1 completion
**Approved By**: Documentation Team
**Date**: 2025-11-10
