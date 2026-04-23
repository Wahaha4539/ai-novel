---
trigger: always_on
---

# Code Commenting Rules

## Mandatory

- When writing or modifying code, ALWAYS add comments where they improve readability.
- Public functions, classes, and modules MUST include comments/docstrings explaining purpose, inputs, outputs, and side effects.
- Complex business logic MUST include inline comments explaining why the logic exists, not just what it does.
- Non-obvious conditions, edge-case handling, retries, caching, concurrency, and error recovery MUST be commented.
- Do NOT add meaningless comments that only restate the code.
- Prefer concise, practical comments over long explanations.
- Follow the existing comment style of the language/framework in the repository.

## Style

- For functions/classes: write structured doc comments when the language supports it.
- For complex blocks: add 1-2 line comments above the block.
- For tricky one-liners: add end-of-line comments only when necessary.
- When refactoring existing code, preserve useful old comments and improve unclear ones.

## Output requirement

- Before finishing a coding task, review the changed code and ensure important logic is commented.
- If a file intentionally has no comments, explain briefly why comments were unnecessary.
