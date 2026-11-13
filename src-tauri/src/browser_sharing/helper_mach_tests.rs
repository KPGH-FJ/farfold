use super::*;
use std::ffi::OsString;
use std::os::unix::ffi::OsStringExt;

fn parse(values: &[&str]) -> Result<(String, u32), ()> {
    mach_args(&mut values.iter().map(OsString::from))
}

#[test]
fn mach_helper_arguments_require_only_public_name_and_exact_positive_pid() {
    let name = format!("ai.farfold.browser.{}", "a".repeat(32));
    assert_eq!(parse(&[&name, "42"]), Ok((name.clone(), 42)));
    assert_eq!(parse(&[&name, "2147483647"]), Ok((name, i32::MAX as u32)));
    for values in [
        vec![],
        vec!["name"],
        vec!["", "1"],
        vec!["name", "0"],
        vec!["name", "-1"],
        vec!["name", "+1"],
        vec!["name", "1 "],
        vec!["name", "1.0"],
        vec!["name", "2147483648"],
        vec!["name", "4294967296"],
        vec!["name", "1", "extra"],
        vec!["name\0other", "1"],
    ] {
        assert!(parse(&values).is_err());
    }
    assert!(parse(&[&"x".repeat(256), "1"]).is_err());
}

#[test]
fn mach_helper_arguments_do_not_lossily_convert_non_utf8_name_or_pid() {
    for args in [
        vec![OsString::from_vec(vec![0xff]), OsString::from("1")],
        vec![OsString::from("name"), OsString::from_vec(vec![0xff])],
    ] {
        assert!(mach_args(&mut args.into_iter()).is_err());
    }
}
