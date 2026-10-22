//! Complete vectors, never subcommand/prefix authorization.
pub(super) fn allowed(args: &[&str]) -> bool {
    if let ["check-ref-format", full] = args {
        // Create always supplies one complete heads ref, never a mode/option.
        // Git remains the authority for the actual reference grammar.
        return full.starts_with("refs/heads/")
            && full.len() > "refs/heads/".len()
            && full.len() <= 211
            && !full.contains('\0');
    }
    matches!(
        args,
        ["rev-parse", "--is-bare-repository"]
            | ["rev-parse", "--show-toplevel"]
            | ["rev-parse", "--absolute-git-dir"]
            | ["rev-parse", "--git-common-dir"]
            | ["rev-parse", "--verify", "HEAD"]
            | ["symbolic-ref", "-q", "HEAD"]
            | ["worktree", "list", "--porcelain", "-z"]
            | ["ls-files", "--stage", "-z"]
            | [
                "for-each-ref",
                "--count=4097",
                "--format=%(refname)%00%(objectname)%00",
                "refs/heads/"
            ]
            | [
                "config",
                "--null",
                "--get-regexp",
                r"^(extensions\.partialclone|remote\..*\.promisor)$"
            ]
            | ["config", "--type=bool", "--get", "core.sparseCheckout"]
            | ["config", "--type=bool", "--get", "core.bare"]
            | ["config", "--get", "core.worktree"]
    )
}
#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn complete_vectors_authorize_only_existing_bounded_reads() {
        for args in [
            vec!["rev-parse", "--verify", "HEAD"],
            vec!["worktree", "list", "--porcelain", "-z"],
            vec!["ls-files", "--stage", "-z"],
            vec!["check-ref-format", "refs/heads/owned-create-control"],
            vec!["config", "--type=bool", "--get", "core.sparseCheckout"],
        ] {
            assert!(allowed(&args));
            let mut extended = args.clone();
            extended.push("--exec=untrusted");
            assert!(!allowed(&extended));
        }
        for args in [
            vec!["worktree", "add", "path"],
            vec!["config", "core.fsmonitor", "command"],
            vec!["rev-parse", "--verify", "HEAD^{commit}"],
            vec!["check-ref-format", "--branch"],
            vec!["check-ref-format", "refs/tags/other"],
            vec!["ls-files", "--stage", "-z", "--", "other"],
            vec![
                "for-each-ref",
                "--count=4098",
                "--format=%(refname)%00%(objectname)%00",
                "refs/heads/",
            ],
        ] {
            assert!(!allowed(&args));
        }
    }
}
