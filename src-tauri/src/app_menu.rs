//! Keep the standard macOS menus, routing Quit through the existing save gate.
use tauri::{
    AppHandle, Runtime,
    menu::{AboutMetadata, Menu, MenuEvent, MenuItem, PredefinedMenuItem, Submenu},
};

const QUIT_ID: &str = "farfold.quit-after-save";

pub(crate) fn create<R: Runtime>(app: &AppHandle<R>) -> tauri::Result<Menu<R>> {
    let menu = Menu::default(app)?;
    // Tauri's macOS default starts with the application submenu. Its native
    // predefined Quit has a generated ID, so do not guess an ID or match text.
    let items = menu.items()?;
    let application = items.first().and_then(|item| item.as_submenu());
    if application.is_none_or(|item| item.text().ok().as_deref() != Some(&app.package_info().name))
    {
        return Err(std::io::Error::other("standard application menu unavailable").into());
    }
    let package = app.package_info();
    let about = AboutMetadata {
        name: Some(package.name.clone()),
        version: Some(package.version.to_string()),
        copyright: app.config().bundle.copyright.clone(),
        authors: app
            .config()
            .bundle
            .publisher
            .clone()
            .map(|value| vec![value]),
        ..Default::default()
    };
    // An ordinary MenuItem uses Muda's menu-event action, never terminate:.
    let quit = MenuItem::with_id(app, QUIT_ID, "退出 Farfold", true, Some("CmdOrCtrl+Q"))?;
    let replacement = Submenu::with_items(
        app,
        &package.name,
        true,
        &[
            &PredefinedMenuItem::about(app, None, Some(about))?,
            &PredefinedMenuItem::separator(app)?,
            &PredefinedMenuItem::services(app, None)?,
            &PredefinedMenuItem::separator(app)?,
            &PredefinedMenuItem::hide(app, None)?,
            &PredefinedMenuItem::hide_others(app, None)?,
            &PredefinedMenuItem::separator(app)?,
            &quit,
        ],
    )?;
    menu.remove_at(0)?;
    menu.insert(&replacement, 0)?;
    Ok(menu)
}

fn dispatch(id: &str, request: impl FnOnce(i32)) {
    if id == QUIT_ID {
        request(0);
    }
}

pub(crate) fn handle<R: Runtime>(app: &AppHandle<R>, event: MenuEvent) {
    dispatch(event.id().as_ref(), |code| app.exit(code));
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn only_owned_quit_requests_normal_exit() {
        let mut requested = Vec::new();
        dispatch(QUIT_ID, |code| requested.push(code));
        assert_eq!(requested, [0]);
        for unrelated in ["", "quit", "copy", "farfold.quit-after-save-extra"] {
            dispatch(unrelated, |_| panic!("unrelated menu item must not exit"));
        }
    }
}
