/**
 * Seed deck written into `<userData>/decks/example.md` on first run if
 * the decks folder is empty. Demonstrates topic-mode (## topic + ###
 * question) so users see the recommended layout up front; flat-mode
 * (no topics, ## as question) is also supported and detected per-file.
 *
 * Auto-upgrade: when the file on disk byte-equals one of the
 * `LEGACY_EXAMPLE_DECKS` versions below, the service overwrites it
 * with the current EXAMPLE_DECK. That covers users who got a stale
 * seed before we added topics / new keybindings, without touching any
 * file they actually edited (anything off by even a whitespace skips
 * the migration).
 */
export const EXAMPLE_DECK = `# Example Deck

## Basics

### What does this app do for me right now?
- [ ] Plays a podcast
- [x] Quizzes me on flashcards stored as Markdown files
- [ ] Renders a PDF
- [ ] Sends an email

> The flashcards module reads .md files from this folder, one deck per
> file. Each \`###\` heading is a card; \`##\` headings group cards into
> topics. Checkboxes are options; blockquotes are explanations.

### What happens to a card when I edit its question text?
- [ ] Nothing, SRS state stays attached
- [x] It becomes a new card with fresh SRS state
- [ ] The whole deck is reset

> Card identity is a hash of the question text. Cosmetic edits
> (whitespace, casing) are normalised, but a real wording change creates
> a new card — which is what you want, since the question is now
> semantically different.

## Keyboard

### Which key reveals the answer without picking?
- [ ] Tab
- [x] Enter
- [ ] Space
- [ ] Backspace

> Pressing Enter counts as "Again" for SRS — the card comes back
> tomorrow. Wrong picks also count as Again. Right picks push the next
> review further out, growing exponentially with each successful repeat.

### Which keys advance to the next card?
- [ ] Only Enter
- [ ] Only the right arrow
- [x] Space, the right arrow, OR W
- [ ] Tab

> Space is the primary one-handed advance — keep your thumb on it while
> the same hand answers with 1-9. W and the right arrow are aliases.
`

/**
 * Byte-for-byte snapshots of every previous shipped EXAMPLE_DECK. The
 * service uses this list for the "auto-upgrade only if untouched"
 * migration (see `example-deck.ts` doc-comment on EXAMPLE_DECK).
 *
 * Append a new entry whenever EXAMPLE_DECK is changed materially —
 * the *previous* version's exact text. Never delete entries; old
 * users may still be on an even-older version.
 */
export const LEGACY_EXAMPLE_DECKS: readonly string[] = [
  // v1 — first shipped seed (pre-topics, F as next-card key).
  `# Example Deck

## What does this app do for me right now?
- [ ] Plays a podcast
- [x] Quizzes me on flashcards stored as Markdown files
- [ ] Renders a PDF
- [ ] Sends an email

> The flashcards module reads .md files from this folder, one deck per
> file. Each \`##\` heading is a card; checkboxes are options;
> blockquotes are explanations.

## Which key reveals the answer without picking?
- [ ] Tab
- [ ] Enter
- [x] Space
- [ ] Backspace

> Pressing Space counts as "Again" for SRS — the card comes back
> tomorrow. Wrong picks also count as Again. Right picks push the next
> review further out, growing exponentially with each successful repeat.

## What happens to a card when I edit its question text?
- [ ] Nothing, SRS state stays attached
- [x] It becomes a new card with fresh SRS state
- [ ] The whole deck is reset

> Card identity is a hash of the question text. Cosmetic edits
> (whitespace, casing) are normalised, but a real wording change creates
> a new card — which is what you want, since the question is now
> semantically different.
`,
  // v2 — added topic-mode (## as topic, ### as question) and the F
  // next-card alias. Replaced by v3 which switched F → W.
  `# Example Deck

## Basics

### What does this app do for me right now?
- [ ] Plays a podcast
- [x] Quizzes me on flashcards stored as Markdown files
- [ ] Renders a PDF
- [ ] Sends an email

> The flashcards module reads .md files from this folder, one deck per
> file. Each \`###\` heading is a card; \`##\` headings group cards into
> topics. Checkboxes are options; blockquotes are explanations.

### What happens to a card when I edit its question text?
- [ ] Nothing, SRS state stays attached
- [x] It becomes a new card with fresh SRS state
- [ ] The whole deck is reset

> Card identity is a hash of the question text. Cosmetic edits
> (whitespace, casing) are normalised, but a real wording change creates
> a new card — which is what you want, since the question is now
> semantically different.

## Keyboard

### Which key reveals the answer without picking?
- [ ] Tab
- [ ] Enter
- [x] Space
- [ ] Backspace

> Pressing Space counts as "Again" for SRS — the card comes back
> tomorrow. Wrong picks also count as Again. Right picks push the next
> review further out, growing exponentially with each successful repeat.

### Which keys advance to the next card?
- [ ] Only Enter
- [ ] Only the right arrow
- [x] Enter, the right arrow, OR F
- [ ] Tab

> F is the one-handed alias — keep your fingers on 1-9 and tap F to
> advance instead of stretching across the keyboard.
`,
  // v3 — switched F → W. Replaced by v4 which swapped Space ↔ Enter
  // (Space is now next-card, Enter is reveal).
  `# Example Deck

## Basics

### What does this app do for me right now?
- [ ] Plays a podcast
- [x] Quizzes me on flashcards stored as Markdown files
- [ ] Renders a PDF
- [ ] Sends an email

> The flashcards module reads .md files from this folder, one deck per
> file. Each \`###\` heading is a card; \`##\` headings group cards into
> topics. Checkboxes are options; blockquotes are explanations.

### What happens to a card when I edit its question text?
- [ ] Nothing, SRS state stays attached
- [x] It becomes a new card with fresh SRS state
- [ ] The whole deck is reset

> Card identity is a hash of the question text. Cosmetic edits
> (whitespace, casing) are normalised, but a real wording change creates
> a new card — which is what you want, since the question is now
> semantically different.

## Keyboard

### Which key reveals the answer without picking?
- [ ] Tab
- [ ] Enter
- [x] Space
- [ ] Backspace

> Pressing Space counts as "Again" for SRS — the card comes back
> tomorrow. Wrong picks also count as Again. Right picks push the next
> review further out, growing exponentially with each successful repeat.

### Which keys advance to the next card?
- [ ] Only Enter
- [ ] Only the right arrow
- [x] Enter, the right arrow, OR W
- [ ] Tab

> W is the one-handed alias — keep your fingers on 1-9 and tap W to
> advance instead of stretching across the keyboard.
`
]
