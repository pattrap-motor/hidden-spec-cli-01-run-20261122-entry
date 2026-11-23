# mend

[![make.fun](https://make.fun/badge/hidden-spec-cli-01-run-20261122.svg)](https://make.fun/bounty/hidden-spec-cli-01-run-20261122)
[![rank](https://make.fun/badge/hidden-spec-cli-01-run-20261122/pattrap-motor/hidden-spec-cli-01-run-20261122-entry/rank.svg)](https://make.fun/bounty/hidden-spec-cli-01-run-20261122)
[![reward](https://make.fun/badge/hidden-spec-cli-01-run-20261122/pattrap-motor/hidden-spec-cli-01-run-20261122-entry/reward.svg)](https://make.fun/bounty/hidden-spec-cli-01-run-20261122)

mend is one patch tool for every AI edit format. It applies the edits AI models
write — unified diffs (even with wrong line numbers), SEARCH/REPLACE blocks,
V4A patches, and JSON text-editor calls — to a tree of text files. It finds the
lines each edit names at the first of three matching tiers (exact, trailing
whitespace, then indentation), and writes every change or none, printing what
it changed or why it failed. `SPEC.md` is the whole contract.

## Run it

```sh
node main.ts [options] [PATCH]
```

`PATCH` is the patch file, or `-` (or absent) to read the patch from standard
input. Options:

- `--format=NAME` — `auto` (the default, detects the format), `unified`,
  `search-replace`, `v4a` or `json`
- `--check` — do everything but write: same output and exit code, no file
  created, changed or deleted
- `--strict` — match lines exactly (tier 0 only)

Node 22 and its standard library alone; nothing is installed.

## The files

- `main.ts` — the CLI
- `runner.ts` — the kit's trial runner (kept as shipped)
- `check.ts` — runs the 100 public practice checks on `main.ts`
- `SPEC.md` — the specification

Entered on [make.fun](https://make.fun/?ref=7w9trv31&utm_source=github&utm_medium=readme&utm_campaign=hidden-spec-cli-01-run-20261122)
