//! Launcher-style fuzzy matching for palette search — port of
//! `src/main/fuzzy-match.ts`, plus the typo-tolerant fallback the Window
//! Switcher used Fuse.js for.
//!
//! What a launcher wants is a subsequence match that pays for *where* the
//! characters landed: the initial of a word beats the middle of one, a run of
//! adjacent characters beats a scattered one. Scoring follows fzf's shape
//! (match value plus boundary/camel/consecutive bonuses, minus gap
//! penalties) over a DP that finds the best alignment, then normalises to
//! Fuse's convention — 0 is perfect, higher is worse — so the registry's
//! ascending sort and every module's hand-assigned score keep their meaning.

const SCORE_MATCH: f64 = 16.0;
const PENALTY_GAP_START: f64 = -3.0;
const PENALTY_GAP_EXTENSION: f64 = -1.0;
/// Start of the string, or the character after a separator.
const BONUS_BOUNDARY: f64 = 8.0;
/// camelCase hump, or a digit starting a run — a weaker word start.
const BONUS_CAMEL: f64 = 7.0;
/// Adjacent to the previous matched character.
const BONUS_CONSECUTIVE: f64 = 4.0;
/// The first character of a token says the most about intent, so its
/// placement bonus counts double.
const FIRST_CHAR_MULTIPLIER: f64 = 2.0;

const NO_MATCH: f64 = f64::NEG_INFINITY;

/// Characters that end a word in app names and window titles.
const SEPARATORS: &[char] = &[
    ' ', '\t', '-', '_', '.', ',', ':', ';', '/', '\\', '|', '(', ')', '[', ']', '{', '}', '<',
    '>', '+', '&', '@', '#', '"', '\'', '`', '~', '*', '!', '?', '=',
];

/// Lowercase one character without changing the string's length, so
/// positions in the lowered text still line up with `boundary_bonuses`
/// computed on the original.
fn lower(c: char) -> char {
    c.to_lowercase().next().unwrap_or(c)
}

/// Placement bonus per character of `target`, in its original case — the
/// camelCase hump in "VSCode" is invisible after lowercasing.
fn boundary_bonuses(target: &[char]) -> Vec<f64> {
    target
        .iter()
        .enumerate()
        .map(|(i, &ch)| {
            if i == 0 {
                return BONUS_BOUNDARY;
            }
            let prev = target[i - 1];
            if SEPARATORS.contains(&prev) {
                BONUS_BOUNDARY
            } else if (prev.is_ascii_lowercase() && ch.is_ascii_uppercase())
                || (!prev.is_ascii_digit() && ch.is_ascii_digit())
            {
                BONUS_CAMEL
            } else {
                0.0
            }
        })
        .collect()
}

/// Best alignment score for one whitespace-free token, or `NO_MATCH` when
/// the token isn't a subsequence of the target at all.
///
/// `row[j]` holds the best score for the token's first `i + 1` characters
/// *ending* at target position `j`. Two ways to reach `j`: adjacent to the
/// previous match (worth a consecutive bonus) or across a gap, whose running
/// best is carried in `reach` so the pass stays linear.
fn score_token(
    token: &[char],
    lower_target: &[char],
    bonuses: &[f64],
    require_boundary_start: bool,
) -> f64 {
    let n = lower_target.len();
    let m = token.len();
    if m == 0 || m > n {
        return NO_MATCH;
    }

    let mut prev_row = vec![NO_MATCH; n];
    let mut row = vec![NO_MATCH; n];

    for (i, &qc) in token.iter().enumerate() {
        let mut reach = NO_MATCH;
        let mut matched_any = false;

        for j in 0..n {
            if j >= 2 && prev_row[j - 2] != NO_MATCH {
                let via_new_gap = prev_row[j - 2] + PENALTY_GAP_START;
                reach = if reach == NO_MATCH {
                    via_new_gap
                } else {
                    via_new_gap.max(reach + PENALTY_GAP_EXTENSION)
                };
            } else if reach != NO_MATCH {
                reach += PENALTY_GAP_EXTENSION;
            }

            if lower_target[j] != qc {
                row[j] = NO_MATCH;
                continue;
            }

            let bonus = bonuses[j];
            let best = if i == 0 {
                if require_boundary_start && bonus == 0.0 {
                    row[j] = NO_MATCH;
                    continue;
                }
                SCORE_MATCH + bonus * FIRST_CHAR_MULTIPLIER
            } else {
                let mut best = NO_MATCH;
                if j >= 1 && prev_row[j - 1] != NO_MATCH {
                    best = prev_row[j - 1] + SCORE_MATCH + BONUS_CONSECUTIVE.max(bonus);
                }
                if reach != NO_MATCH {
                    best = best.max(reach + SCORE_MATCH + bonus);
                }
                best
            };

            row[j] = best;
            if best != NO_MATCH {
                matched_any = true;
            }
        }

        // No position could host this character after the previous one.
        if !matched_any {
            return NO_MATCH;
        }
        std::mem::swap(&mut prev_row, &mut row);
    }

    prev_row.into_iter().fold(NO_MATCH, f64::max)
}

fn contains(haystack: &[char], needle: &[char]) -> bool {
    needle.len() <= haystack.len() && haystack.windows(needle.len()).any(|w| w == needle)
}

/// Score for one token, gated on the match being *anchored*: the token
/// starts a word ("ch" for Chrome, "jj" for "Jenkins Jobs") or appears
/// verbatim ("hrome"). Characters scattered through unrelated words are
/// noise — "ide" must not find w-i-n-d-ows-t-e-rminal.
fn match_token(token: &[char], lower_target: &[char], bonuses: &[f64]) -> f64 {
    let anchored = score_token(token, lower_target, bonuses, true);
    if anchored != NO_MATCH {
        return anchored;
    }
    if !contains(lower_target, token) {
        return NO_MATCH;
    }
    score_token(token, lower_target, bonuses, false)
}

/// Ceiling for a token of length `len`: every character on a word boundary.
fn max_token_score(len: usize) -> f64 {
    SCORE_MATCH * len as f64
        + BONUS_BOUNDARY * FIRST_CHAR_MULTIPLIER
        + BONUS_BOUNDARY * (len as f64 - 1.0)
}

/// Split on whitespace and match each token independently against the whole
/// target — what lets "vpn on" ignore the `- ` between the words and makes
/// word order free. `None` when any token fails to land.
pub fn fuzzy_score(query: &str, target: &str) -> Option<f64> {
    let tokens: Vec<Vec<char>> = query
        .split_whitespace()
        .map(|t| t.chars().map(lower).collect())
        .collect();
    if tokens.is_empty() || target.is_empty() {
        return None;
    }

    let target_chars: Vec<char> = target.chars().collect();
    let lower_target: Vec<char> = target_chars.iter().map(|&c| lower(c)).collect();
    let bonuses = boundary_bonuses(&target_chars);

    let mut total = 0.0;
    let mut ceiling = 0.0;
    for token in &tokens {
        let score = match_token(token, &lower_target, &bonuses);
        if score == NO_MATCH {
            return None;
        }
        total += score;
        ceiling += max_token_score(token.len());
    }

    // Map onto the 0-is-perfect scale. The length term only breaks ties:
    // between two names that match equally well, the shorter one is the
    // more specific hit ("Notion" over "Notion Calendar Helper").
    let normalised = 1.0 - (total / ceiling).clamp(0.0, 1.0);
    Some(normalised * 0.99 + (target_chars.len().min(200) as f64) / 200_000.0)
}

/// Errors allowed per query character by [`typo_score`] — the 0.4 budget
/// the Window Switcher gave Fuse, enough for one transposition in a
/// six-letter word ("chorme").
const TYPO_THRESHOLD: f64 = 0.4;

/// Longest target prefix the typo pass looks at; keeps the DP bounded on
/// pathological window titles.
const TYPO_MAX_TARGET: usize = 512;

/// Typo-tolerant fallback, used only when [`fuzzy_score`] found nothing
/// anywhere. Edit distance of the query against the best-matching stretch
/// of the target (Sellers' approximate substring match), divided by the
/// query length. Replaces the Fuse.js pass of the Electron build; the
/// numbers differ slightly from Fuse's, the ordering intent does not.
pub fn typo_score(query: &str, target: &str) -> Option<f64> {
    let query: Vec<char> = query.trim().chars().map(lower).collect();
    if query.is_empty() || target.is_empty() {
        return None;
    }
    let target: Vec<char> = target.chars().take(TYPO_MAX_TARGET).map(lower).collect();

    // prev[j] = edit distance of query[..i] against the best substring
    // of target ending at j. Row 0 is all zeros: the match may start
    // anywhere in the target.
    let mut prev = vec![0usize; target.len() + 1];
    let mut row = vec![0usize; target.len() + 1];
    for (i, &qc) in query.iter().enumerate() {
        row[0] = i + 1;
        for (j, &tc) in target.iter().enumerate() {
            let substitute = prev[j] + usize::from(qc != tc);
            row[j + 1] = substitute.min(prev[j + 1] + 1).min(row[j] + 1);
        }
        std::mem::swap(&mut prev, &mut row);
    }
    let distance = prev.iter().copied().min().unwrap_or(query.len());
    let score = distance as f64 / query.len() as f64;
    (score <= TYPO_THRESHOLD).then_some(score)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn score(q: &str, t: &str) -> f64 {
        fuzzy_score(q, t).unwrap_or_else(|| panic!("{q:?} should match {t:?}"))
    }

    #[test]
    fn words_beat_scattered_letters() {
        // The motivating pair from fuzzy-match.ts: "vpn on" must land on
        // "- On", not tie with "- Off".
        assert!(fuzzy_score("vpn on", "Corp VPN - Off").is_none());
        assert!(fuzzy_score("vpn on", "Corp VPN - On").is_some());
        assert!(score("on", "Corp VPN - On") < score("on", "Notion"));
    }

    #[test]
    fn unanchored_scatter_is_rejected() {
        assert!(fuzzy_score("ide", "WindowsTerminal.exe").is_none());
    }

    #[test]
    fn acronyms_and_verbatim_middles_match() {
        assert!(fuzzy_score("jj", "Jenkins Jobs").is_some());
        assert!(fuzzy_score("hrome", "Chrome").is_some());
        assert!(fuzzy_score("vsc", "VSCode").is_some());
    }

    #[test]
    fn word_order_is_free() {
        assert_eq!(
            score("vpn on", "Corp VPN - On"),
            score("on vpn", "Corp VPN - On")
        );
    }

    #[test]
    fn shorter_name_wins_a_tie() {
        assert!(score("notion", "Notion") < score("notion", "Notion Calendar Helper"));
    }

    #[test]
    fn empty_inputs_never_match() {
        assert!(fuzzy_score("", "Chrome").is_none());
        assert!(fuzzy_score("   ", "Chrome").is_none());
        assert!(fuzzy_score("c", "").is_none());
    }

    #[test]
    fn perfect_prefix_scores_near_zero() {
        let s = score("chrome", "Chrome");
        assert!(s < 0.2, "{s}");
    }

    #[test]
    fn typo_fallback_tolerates_a_transposition() {
        assert!(fuzzy_score("chorme", "Google Chrome").is_none());
        let s = typo_score("chorme", "Google Chrome").unwrap();
        assert!((s - 2.0 / 6.0).abs() < 1e-9, "{s}");
        assert!(typo_score("xyzzy", "Google Chrome").is_none());
        assert!(typo_score("", "Google Chrome").is_none());
    }
}
