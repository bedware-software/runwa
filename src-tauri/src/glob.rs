//! Anchored, case-insensitive glob matching for the small user-authored
//! patterns runwa stores (Window Switcher ignore rules, User Command app
//! scopes). Port of `src/main/glob-match.ts`.
//!
//! `*` is the only wildcard; every other character is literal. The values
//! these patterns run against — window titles, executable paths — are full
//! of regex metacharacters (`Telegram (26011)`, `C:\dev — Code`), which is
//! why there's no regex involved at all.

/// True when `value` matches `pattern`. An empty pattern is the "any"
/// wildcard — that's what makes a process-only ignore rule
/// (`{ title: '', processName: 'ktalk.exe' }`) hide every window of an app.
pub fn glob_matches(pattern: &str, value: &str) -> bool {
    if pattern.is_empty() {
        return true;
    }
    let pattern: Vec<char> = pattern.chars().flat_map(char::to_lowercase).collect();
    let value: Vec<char> = value.trim().chars().flat_map(char::to_lowercase).collect();
    wildcard_match(&pattern, &value)
}

/// Iterative `*` matcher with single-point backtracking: linear in the
/// common case, never exponential.
fn wildcard_match(pattern: &[char], value: &[char]) -> bool {
    let (mut p, mut v) = (0, 0);
    let mut star: Option<usize> = None;
    let mut resume = 0;
    while v < value.len() {
        if p < pattern.len() && pattern[p] == '*' {
            star = Some(p);
            p += 1;
            resume = v;
        } else if p < pattern.len() && pattern[p] == value[v] {
            p += 1;
            v += 1;
        } else if let Some(star_at) = star {
            p = star_at + 1;
            resume += 1;
            v = resume;
        } else {
            return false;
        }
    }
    pattern[p..].iter().all(|&c| c == '*')
}

#[cfg(test)]
mod tests {
    use super::glob_matches;

    #[test]
    fn empty_pattern_matches_anything() {
        assert!(glob_matches("", "whatever"));
        assert!(glob_matches("", ""));
    }

    #[test]
    fn literal_match_is_anchored_and_case_insensitive() {
        assert!(glob_matches("ktalk.exe", "KTalk.EXE"));
        assert!(!glob_matches("talk.exe", "ktalk.exe"));
        assert!(!glob_matches("ktalk", "ktalk.exe"));
    }

    #[test]
    fn value_is_trimmed() {
        assert!(glob_matches("code.exe", "  Code.exe "));
    }

    #[test]
    fn regex_metacharacters_are_literal() {
        assert!(glob_matches("Telegram (26011)", "Telegram (26011)"));
        assert!(!glob_matches("Telegram (2601.)", "Telegram (26011)"));
        assert!(glob_matches("C:\\dev — Code", "c:\\DEV — code"));
    }

    #[test]
    fn star_matches_any_run() {
        assert!(glob_matches("Telegram*", "Telegram (26011)"));
        assert!(glob_matches(
            "*idea*",
            "C:\\Program Files\\JetBrains\\idea64.exe"
        ));
        assert!(glob_matches("a*b*c", "aXXbYYc"));
        assert!(!glob_matches("a*b*c", "aXXbYY"));
        assert!(glob_matches("*", ""));
        assert!(glob_matches("**", "x"));
    }
}
