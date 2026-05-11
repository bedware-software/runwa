/**
 * Default content written to `<userData>/flashcards-llm-prompt.md` on
 * first run. Mirrors the `keyboard-rules.yaml` template pattern: lives
 * as an editable file the user can tune in their preferred editor;
 * the settings panel only shows a read-only preview.
 *
 * Auto-upgrade: when the file on disk byte-equals one of the
 * `LEGACY_LLM_PROMPTS` versions below, the service overwrites it
 * with the current DEFAULT_LLM_PROMPT (see `service.ts ::
 * ensureLlmPromptFile`). Anything off by even a whitespace is
 * treated as user-edited and left alone.
 */
export const DEFAULT_LLM_PROMPT = `You are generating a flashcard deck for spaced repetition study.

Output a single Markdown document in this exact format:

# <Deck Title>

## <Topic Name>             # optional — group cards by topic; can be omitted

### Question text (multiline OK; code fences with \`\`\` allowed)
- [ ] wrong option
- [x] correct option
- [ ] wrong option
- [ ] wrong option

> One short paragraph explaining the answer (optional but encouraged).

### Next question…

Process — ask before assuming:
- Before you start, if anything about the source material is
  ambiguous (scope, audience, depth, what's in vs out of scope),
  ask first. Don't guess.
- While generating, pause whenever a real question comes up —
  how to group cards into topics, what difficulty to aim for,
  whether to split or merge a card, whether something is even
  worth including. Ask, then continue.
- If the source material is incomplete (e.g. a GitHub-style
  question list where some entries are placeholders / empty /
  one-liners with no real content), do NOT invent answers from
  general knowledge to "fill the gap". Flag the gap, list the
  affected entries, and ask the user how to handle them — skip,
  research from a specific source, leave a TODO card, etc.
- Don't silently invent. A short clarifying question is always
  better than a card the user has to throw out later.

Rules:
- Each card has EXACTLY ONE correct option marked \`[x]\`.
- Aim for 4 options where it makes sense (3 distractors), minimum 2.
- Use \`###\` for questions and \`##\` for topics. If you don't need topics,
  drop the \`##\` lines and put \`###\` directly under the deck title.
- Keep questions self-contained — no "as discussed above".
- Make the wrong options similar in length / style to the correct one
  so the answer isn't obvious from typography.
- Wrap any code in fenced \`\`\`language … \`\`\` blocks.

Source material — generate at least 12 well-formed cards from this.
The source can be:
- A blob of notes / outline pasted directly below.
- A URL (GitHub repo / file / issue list, blog post, docs page) —
  you're expected to fetch and parse it. If you don't have web
  access in this conversation, say so and ask the user to paste
  the relevant text instead.
- A mix of both.

<paste your notes or URLs here>
`

/**
 * Byte-for-byte snapshots of every previous shipped DEFAULT_LLM_PROMPT.
 * The service uses this list for the "auto-upgrade only if untouched"
 * migration of the on-disk prompt file.
 *
 * Append a new entry whenever DEFAULT_LLM_PROMPT changes materially —
 * the *previous* version's exact text. Never delete entries; old
 * users may still be on an even-older version.
 */
export const LEGACY_LLM_PROMPTS: readonly string[] = [
  // v1 — first shipped prompt (pre-"Process — ask before assuming"
  // section).
  `You are generating a flashcard deck for spaced repetition study.

Output a single Markdown document in this exact format:

# <Deck Title>

## <Topic Name>             # optional — group cards by topic; can be omitted

### Question text (multiline OK; code fences with \`\`\` allowed)
- [ ] wrong option
- [x] correct option
- [ ] wrong option
- [ ] wrong option

> One short paragraph explaining the answer (optional but encouraged).

### Next question…

Rules:
- Each card has EXACTLY ONE correct option marked \`[x]\`.
- Aim for 4 options where it makes sense (3 distractors), minimum 2.
- Use \`###\` for questions and \`##\` for topics. If you don't need topics,
  drop the \`##\` lines and put \`###\` directly under the deck title.
- Keep questions self-contained — no "as discussed above".
- Make the wrong options similar in length / style to the correct one
  so the answer isn't obvious from typography.
- Wrap any code in fenced \`\`\`language … \`\`\` blocks.

Source material — generate at least 12 well-formed cards from this:

<paste your notes here>
`,
  // v2 — added "Process — ask before assuming" section. Replaced by
  // v3 which adds the URL/incomplete-data guidance.
  `You are generating a flashcard deck for spaced repetition study.

Output a single Markdown document in this exact format:

# <Deck Title>

## <Topic Name>             # optional — group cards by topic; can be omitted

### Question text (multiline OK; code fences with \`\`\` allowed)
- [ ] wrong option
- [x] correct option
- [ ] wrong option
- [ ] wrong option

> One short paragraph explaining the answer (optional but encouraged).

### Next question…

Process — ask before assuming:
- Before you start, if anything about the source material is
  ambiguous (scope, audience, depth, what's in vs out of scope),
  ask first. Don't guess.
- While generating, pause whenever a real question comes up —
  how to group cards into topics, what difficulty to aim for,
  whether to split or merge a card, whether something is even
  worth including. Ask, then continue.
- Don't silently invent. A short clarifying question is always
  better than a card the user has to throw out later.

Rules:
- Each card has EXACTLY ONE correct option marked \`[x]\`.
- Aim for 4 options where it makes sense (3 distractors), minimum 2.
- Use \`###\` for questions and \`##\` for topics. If you don't need topics,
  drop the \`##\` lines and put \`###\` directly under the deck title.
- Keep questions self-contained — no "as discussed above".
- Make the wrong options similar in length / style to the correct one
  so the answer isn't obvious from typography.
- Wrap any code in fenced \`\`\`language … \`\`\` blocks.

Source material — generate at least 12 well-formed cards from this:

<paste your notes here>
`
]
