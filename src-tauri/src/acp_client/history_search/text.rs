//! A temporary plain-text window, preserving original UTF-16 highlight offsets.
use super::types::Range;
pub(super) struct Match {
    pub text: String,
    pub text_truncated: bool,
    pub ranges: Vec<Range>,
    pub ranges_truncated: bool,
}
pub(super) fn find(text: &str, query: &str) -> Option<Match> {
    let needle: String = query.chars().flat_map(char::to_lowercase).collect();
    if needle.is_empty() {
        return None;
    }
    let mut folded = String::new();
    // Each normalized scalar is tied to its original scalar byte interval.
    let mut map = Vec::new();
    for (start, c) in text.char_indices() {
        for lower in c.to_lowercase() {
            let from = folded.len();
            folded.push(lower);
            map.push((from, folded.len(), start, start + c.len_utf8()));
        }
    }
    let mut found = Vec::new();
    for (start, _) in folded.match_indices(&needle) {
        let end = start + needle.len();
        let first = map.partition_point(|v| v.1 <= start);
        let last = map.partition_point(|v| v.0 < end).checked_sub(1)?;
        let range = (map.get(first)?.2, map.get(last)?.3);
        if found.last() != Some(&range) {
            found.push(range);
        }
    }
    let first = *found.first()?;
    let mut boundaries: Vec<usize> = text.char_indices().map(|(i, _)| i).collect();
    boundaries.push(text.len());
    let anchor = boundaries.partition_point(|b| *b < first.0);
    let from = if text.len() <= 16384 {
        0
    } else {
        anchor.saturating_sub(1536)
    };
    let mut to = if text.len() <= 16384 {
        boundaries.len() - 1
    } else {
        (from + 4096).min(boundaries.len() - 1)
    };
    while boundaries[to] - boundaries[from] > 16384 {
        to -= 1;
    }
    let (left, right) = (boundaries[from], boundaries[to]);
    let window = &text[left..right];
    let visible: Vec<_> = found
        .iter()
        .filter(|(a, b)| *a >= left && *b <= right)
        .collect();
    let ranges = visible
        .iter()
        .take(64)
        .map(|&&(a, b)| Range {
            start: text[left..a].encode_utf16().count(),
            end: text[left..b].encode_utf16().count(),
        })
        .collect();
    Some(Match {
        text: window.into(),
        text_truncated: left != 0 || right != text.len(),
        ranges,
        ranges_truncated: found.len() > visible.len() || visible.len() > 64,
    })
}
#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn unicode_original_offsets() {
        let m = find("😀 Aİ hello HELLO", "i").unwrap();
        assert_eq!(m.ranges, vec![Range { start: 4, end: 5 }]);
        let m = find("😀 Hello HELLO", "hello").unwrap();
        assert_eq!(
            m.ranges,
            vec![Range { start: 3, end: 8 }, Range { start: 9, end: 14 }]
        );
    }
    #[test]
    fn bounded_window_keeps_actual_match() {
        let value = format!("{}needle{}", "世".repeat(12000), "界".repeat(12000));
        let m = find(&value, "needle").unwrap();
        assert!(m.text_truncated);
        assert!(m.text.len() <= 16384);
        let units: Vec<_> = m.text.encode_utf16().collect();
        let r = &m.ranges[0];
        assert_eq!(
            String::from_utf16(&units[r.start..r.end]).unwrap(),
            "needle"
        );
    }
    #[test]
    fn regex_is_literal_and_ranges_bounded() {
        assert!(find("abc", "a.*c").is_none());
        let m = find(&"a ".repeat(100), "a").unwrap();
        assert_eq!(m.ranges.len(), 64);
        assert!(m.ranges_truncated);
    }
}
