# DEVLOG Entry Templates

## Feature

```markdown
## YYYY-MM-DD — Add [feature name]

**Scope:** feature

**Changes:**
- Implemented [what] in [where]
- Added [supporting change]

**Files touched:**
- `path/to/file` — new module for [purpose]
- `path/to/file` — integrated [feature] into [system]

**Decisions & rationale:**
- Chose [approach] over [alternative] because [reason]

**Next steps:**
- [Follow-up work]
```

## Bugfix

```markdown
## YYYY-MM-DD — Fix [bug description]

**Scope:** bugfix

**Root cause:** [What was wrong and why]

**Changes:**
- Fixed [what] in [where]

**Files touched:**
- `path/to/file` — [what was fixed]

**How to verify:**
- [Steps to confirm the fix]
```

## Refactor

```markdown
## YYYY-MM-DD — Refactor [area]

**Scope:** refactor

**Motivation:** [Why this refactor was needed]

**Changes:**
- Extracted [what] from [where] into [new location]
- Renamed [old] → [new]

**Files touched:**
- `path/to/file` — [change description]

**Known issues / tech debt:**
- [Any remaining cleanup]

**Breaking changes:** none | [description]
```

## Config / Infra

```markdown
## YYYY-MM-DD — Update [config area]

**Scope:** config

**Changes:**
- Changed [setting] from [old] to [new] because [reason]

**Files touched:**
- `path/to/config` — [what changed]

**Deployment notes:**
- [Any env vars, build steps, or rollout considerations]
```

## Multi-change Session

```markdown
## YYYY-MM-DD — [Session summary]

**Scope:** mixed

**Changes:**
1. **[Area 1]** — [Description]
2. **[Area 2]** — [Description]

**Files touched:**
- `path/to/file` — [change]
- `path/to/file` — [change]

**Decisions & rationale:**
- [Key decisions made during this session]

**Known issues / tech debt:**
- [Items for future attention]

**Next steps:**
- [Priority follow-ups]
```
