---
description: Generate milestone posts (X, Farcaster, GitHub Release) from what actually shipped
---

Generate launch posts for the milestone described in $ARGUMENTS (if empty, work
out which milestone just landed from recent commits and release notes).

Ground every claim in the repository before writing a word:

1. `git log --oneline -20` and read the newest file in `docs/releases/`.
2. Pull the real numbers — test counts, migration ids, verified behaviours — from
   that release note. Never invent a number.
3. Read `docs/launch/run-guide.md` and find the stage this milestone belongs to.
   Use the **exact claim language** that stage permits, and honour its "never
   claim" line.

Then produce, in one message:

- **X post** (under 280 chars): one claim, concrete, no hype words. If the
  milestone has a failure story (something refused, something held), lead with
  it — that is the differentiated post.
- **X thread** (only for Stage 5 and 7): 4-6 posts. Post 1 the claim, middle
  posts the evidence including what failed safely, last post the limitation and
  a link.
- **Farcaster post**: same substance, slightly more technical, no thread unless
  the X thread exists.
- **GitHub Release note**: title, what shipped, what was verified with counts,
  and an explicit "what this does not do yet" section.

Hard rules:
- Say "Arc Testnet" in the same sentence as any payment claim, until mainnet
  acceptance has actually passed.
- Never write "payments are live" for a self-funded test run.
- Never write "secure", "verified" or "guaranteed" about anything without a test
  behind it.
- If the repository does not support a claim, say so and leave it out rather
  than softening it.

End with a one-line checklist of what to verify live before posting.
