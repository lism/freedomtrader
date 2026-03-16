---
name: dev-docs
description: Maintain a development log (DEVLOG.md) at the project root. Use at the START and END of every coding session, after implementing features, fixing bugs, refactoring code, or making any meaningful code changes. Automatically triggered for all development tasks.
---

# Development Documentation

Every coding session MUST maintain `DEVLOG.md` at the project root. This is non-negotiable.

## When to Update

- **Session start** — Read existing DEVLOG.md, understand recent context
- **Session end** — Append session summary before committing
- **After each meaningful change** — Feature, bugfix, refactor, config change

## Workflow

### 1. Session Start

Read `DEVLOG.md` (create if missing). Review the last 2-3 entries for context.

### 2. During Development

Track what you're doing mentally. Note:
- Files changed and why
- Key decisions made
- Problems encountered and how they were solved
- Any tech debt introduced or resolved

### 3. Session End (MANDATORY before commit)

Append a new entry to `DEVLOG.md` using this format:

```markdown
## YYYY-MM-DD — Brief Title

**Scope:** feature | bugfix | refactor | config | docs

**Changes:**
- Concise description of what changed and why
- Another change...

**Files touched:**
- `path/to/file.js` — what was modified
- `path/to/other.js` — what was modified

**Decisions & rationale:**
- Decision made → why this approach was chosen

**Known issues / tech debt:**
- Any remaining issues or shortcuts taken

**Next steps:**
- What should be done next
```

## Rules

1. **One entry per session** — Don't overwrite previous entries, always append
2. **Be specific** — "Fixed trading bug" is bad; "Fixed SOL sell tx failing when token has transfer fee due to missing fee account in instruction" is good
3. **Include file paths** — Future you needs to know WHERE things changed
4. **Document WHY** — Code shows WHAT changed; the log explains WHY
5. **Keep entries compact** — Each entry should be 10-30 lines, not a novel
6. **Record decisions** — If you chose approach A over B, say why
7. **Flag tech debt** — If you took a shortcut, note it for future cleanup

## Creating DEVLOG.md (first time only)

If `DEVLOG.md` doesn't exist, create it with:

```markdown
# Development Log

Chronological record of development sessions, decisions, and changes.

---
```

Then append the first entry.

## Format Reference

See [templates.md](templates.md) for entry templates for different change types.
