fn main() {
    let mut arguments = std::env::args_os();
    let _executable = arguments.next();
    if arguments.next().as_deref()
        == Some(std::ffi::OsStr::new(
            farfold_lib::MANAGED_UPDATE_SMOKE_ARGUMENT,
        ))
    {
        let Some(database_path) = arguments.next() else {
            std::process::exit(2);
        };
        if arguments.next().is_some() {
            std::process::exit(2);
        }
        if farfold_lib::run_managed_update_smoke(database_path.into()).is_err() {
            std::process::exit(1);
        }
        return;
    }
    farfold_lib::run();
}
