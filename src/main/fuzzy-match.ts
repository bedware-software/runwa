/**
 * Launcher-style fuzzy matching for palette search.
 *
 * Fuse's bitap pass — what app search used before — scores a query as one
 * edit-distance blob and knows nothing about word boundaries. On the real
 * pair "Corp VPN - Off" / "Corp VPN - On" the query "vpn on" costs the same
 * number of edits against both (the `- ` separator is as expensive as the
 * Off/On difference), so they tied and the order fell back to the
 * enumeration order. "on" alone scored `Notion` above `Corp VPN - On`.
 *
 * What a launcher actually wants is a subsequence match that pays for
 * *where* the characters landed: the initial of a word beats the middle of
 * one, a run of adjacent characters beats a scattered one. That ranks
 * "vpn on" and "vpnon" onto `- On` for the same reason a human does — `On`
 * is a whole word there, and only three letters of `Off` line up at all.
 *
 * Scoring follows fzf's shape (match value plus boundary/camel/consecutive
 * bonuses, minus gap penalties) over a DP that finds the best alignment
 * rather than the first one, then normalises to Fuse's convention — 0 is
 * perfect, higher is worse — so the registry's ascending sort and every
 * module's hand-assigned score still mean the same thing.
 */

const SCORE_MATCH = 16
const PENALTY_GAP_START = -3
const PENALTY_GAP_EXTENSION = -1
/** Start of the string, or the character after a separator. */
const BONUS_BOUNDARY = 8
/** camelCase hump, or a digit starting a run — a weaker word start. */
const BONUS_CAMEL = 7
/** Adjacent to the previous matched character. */
const BONUS_CONSECUTIVE = 4
/**
 * The first character of a token says the most about intent ("vpn" wants a
 * name whose word starts with V), so its placement bonus counts double.
 */
const FIRST_CHAR_MULTIPLIER = 2

const NO_MATCH = Number.NEGATIVE_INFINITY

/** Characters that end a word in app names and window titles. */
const SEPARATORS = new Set([
  ' ', '\t', '-', '_', '.', ',', ':', ';', '/', '\\', '|', '(', ')', '[', ']',
  '{', '}', '<', '>', '+', '&', '@', '#', '"', "'", '`', '~', '*', '!', '?', '='
])

function isUpper(ch: string): boolean {
  return ch >= 'A' && ch <= 'Z'
}

function isLower(ch: string): boolean {
  return ch >= 'a' && ch <= 'z'
}

function isDigit(ch: string): boolean {
  return ch >= '0' && ch <= '9'
}

/**
 * Placement bonus per character of `target`, computed once per candidate and
 * reused across every query token. `target` keeps its original case — the
 * camelCase hump in "VSCode" is invisible after lowercasing.
 */
function boundaryBonuses(target: string): Int8Array {
  const bonuses = new Int8Array(target.length)
  for (let i = 0; i < target.length; i++) {
    const ch = target[i]
    if (i === 0) {
      bonuses[i] = BONUS_BOUNDARY
      continue
    }
    const prev = target[i - 1]
    if (SEPARATORS.has(prev)) bonuses[i] = BONUS_BOUNDARY
    else if (isLower(prev) && isUpper(ch)) bonuses[i] = BONUS_CAMEL
    else if (!isDigit(prev) && isDigit(ch)) bonuses[i] = BONUS_CAMEL
    else bonuses[i] = 0
  }
  return bonuses
}

/**
 * Best alignment score for one whitespace-free token, or `NO_MATCH` when the
 * token isn't a subsequence of the target at all.
 *
 * `row[j]` holds the best score for the token's first `i + 1` characters
 * *ending* at target position `j`. Two ways to reach `j`: adjacent to the
 * previous match (free, and worth a consecutive bonus) or across a gap,
 * whose running best is carried in `reach` so the whole pass stays linear
 * instead of re-scanning every earlier position.
 *
 * `requireBoundaryStart` restricts the token's first character to a word
 * start — see `matchToken` for why that gate exists.
 */
function scoreToken(
  token: string,
  lowerTarget: string,
  bonuses: Int8Array,
  requireBoundaryStart: boolean
): number {
  const n = lowerTarget.length
  const m = token.length
  if (m === 0 || m > n) return NO_MATCH

  let prevRow = new Float64Array(n).fill(NO_MATCH)
  let row = new Float64Array(n)

  for (let i = 0; i < m; i++) {
    const qc = token[i]
    // Best score for the previous token character finishing at any position
    // far enough back to leave a gap of at least one character before `j`.
    let reach = NO_MATCH
    let matchedAny = false

    for (let j = 0; j < n; j++) {
      if (j >= 2 && prevRow[j - 2] !== NO_MATCH) {
        const viaNewGap = prevRow[j - 2] + PENALTY_GAP_START
        reach =
          reach === NO_MATCH
            ? viaNewGap
            : Math.max(viaNewGap, reach + PENALTY_GAP_EXTENSION)
      } else if (reach !== NO_MATCH) {
        reach += PENALTY_GAP_EXTENSION
      }

      if (lowerTarget[j] !== qc) {
        row[j] = NO_MATCH
        continue
      }

      const bonus = bonuses[j]
      let best: number
      if (i === 0) {
        if (requireBoundaryStart && bonus === 0) {
          row[j] = NO_MATCH
          continue
        }
        best = SCORE_MATCH + bonus * FIRST_CHAR_MULTIPLIER
      } else {
        best = NO_MATCH
        // Adjacent to the previous match: a run of characters the user typed
        // as one word. Boundary placement still wins if it's worth more.
        if (j >= 1 && prevRow[j - 1] !== NO_MATCH) {
          best =
            prevRow[j - 1] + SCORE_MATCH + Math.max(BONUS_CONSECUTIVE, bonus)
        }
        if (reach !== NO_MATCH) {
          best = Math.max(best, reach + SCORE_MATCH + bonus)
        }
      }

      row[j] = best
      if (best !== NO_MATCH) matchedAny = true
    }

    // No position could host this character after the previous one — the
    // token isn't a subsequence, so no later character can rescue it.
    if (!matchedAny) return NO_MATCH

    const swap = prevRow
    prevRow = row
    row = swap
  }

  let best = NO_MATCH
  for (let j = 0; j < n; j++) if (prevRow[j] > best) best = prevRow[j]
  return best
}

/**
 * Score for one token, gated on the match being *anchored*.
 *
 * Plain subsequence matching admits characters scattered through the middle
 * of unrelated words, and those hits are noise rather than weak signal: the
 * window switcher's "ide" finds w-i-n-d-ows-t-e-rminal, so three terminal
 * windows crowd a search for an IDE. Two shapes carry real evidence of what
 * the user meant — the token starting a word (how people type: "ch" for
 * Chrome, "jj" for "Jenkins Jobs"), or the token appearing verbatim, which
 * covers typing from the middle of one ("hrome"). Anything else is rejected.
 *
 * The anchored pass runs first so its alignment sets the score; the verbatim
 * pass only runs when no word start could host the token at all.
 */
function matchToken(
  token: string,
  lowerTarget: string,
  bonuses: Int8Array
): number {
  const anchored = scoreToken(token, lowerTarget, bonuses, true)
  if (anchored !== NO_MATCH) return anchored
  if (!lowerTarget.includes(token)) return NO_MATCH
  return scoreToken(token, lowerTarget, bonuses, false)
}

/**
 * Ceiling for a token of length `len`: every character landing on a word
 * boundary. Real matches never reach it (consecutive characters can't all
 * start words), which is fine — it only has to be a stable divisor so
 * scores from tokens of different lengths add up comparably.
 */
function maxTokenScore(len: number): number {
  return (
    SCORE_MATCH * len +
    BONUS_BOUNDARY * FIRST_CHAR_MULTIPLIER +
    BONUS_BOUNDARY * (len - 1)
  )
}

/**
 * Split on whitespace and match each token independently against the whole
 * target. Independent tokens are what let "vpn on" ignore the `- ` sitting
 * between them — and, as a side effect, what makes word order free, so
 * "on vpn" finds the same app.
 */
export function fuzzyScore(query: string, target: string): number | null {
  const tokens = query.toLowerCase().split(/\s+/).filter((t) => t.length > 0)
  if (tokens.length === 0) return null
  if (target.length === 0) return null

  const lowerTarget = target.toLowerCase()
  const bonuses = boundaryBonuses(target)

  let total = 0
  let ceiling = 0
  for (const token of tokens) {
    const score = matchToken(token, lowerTarget, bonuses)
    // Every token has to land somewhere: typing a second word narrows the
    // list, it never widens it.
    if (score === NO_MATCH) return null
    total += score
    ceiling += maxTokenScore(token.length)
  }

  // Map onto Fuse's 0-is-perfect scale. The length term is a tiebreak, not a
  // ranking signal: between two names that match equally well, the shorter
  // one is the more specific hit ("Notion" over "Notion Calendar Helper").
  const normalised = 1 - Math.max(0, Math.min(1, total / ceiling))
  return normalised * 0.99 + Math.min(target.length, 200) / 200000
}
