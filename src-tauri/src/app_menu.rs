//! Fully Chinese application menus. Predefined items keep native behavior;
//! owned custom items emit `app-menu` for the frontend to route. Quit keeps
//! going through the existing save gate instead of a native terminate.
use tauri::{
    AppHandle, Emitter, Runtime,
    menu::{AboutMetadata, Menu, MenuEvent, MenuItem, PredefinedMenuItem, Submenu},
};

const QUIT_ID: &str = "farfold.quit-after-save";
const CHECK_UPDATES_ID: &str = "farfold.menu.checkUpdates";
const SETTINGS_ID: &str = "farfold.menu.settings";
const NEW_ID: &str = "farfold.menu.new";
const SEARCH_ID: &str = "farfold.menu.search";
const TOGGLE_SIDEBAR_ID: &str = "farfold.menu.toggleSidebar";
const SHORTCUTS_ID: &str = "farfold.menu.shortcuts";
const PRIVACY_ID: &str = "farfold.menu.privacy";

const OWNED: &[(&str, &str)] = &[
    (CHECK_UPDATES_ID, "checkUpdates"),
    (SETTINGS_ID, "settings"),
    (NEW_ID, "new"),
    (SEARCH_ID, "search"),
    (TOGGLE_SIDEBAR_ID, "toggleSidebar"),
    (SHORTCUTS_ID, "shortcuts"),
    (PRIVACY_ID, "privacy"),
];

fn action(id: &str) -> Option<&'static str> {
    OWNED
        .iter()
        .find(|(owned, _)| *owned == id)
        .map(|(_, action)| *action)
}

pub(crate) fn create<R: Runtime>(app: &AppHandle<R>) -> tauri::Result<Menu<R>> {
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
    // An ordinary MenuItem routes through the menu event, never terminate:.
    let application = Submenu::with_items(
        app,
        &package.name,
        true,
        &[
            &PredefinedMenuItem::about(app, Some("关于 Farfold"), Some(about))?,
            &MenuItem::with_id(app, CHECK_UPDATES_ID, "检查更新…", true, None::<&str>)?,
            &PredefinedMenuItem::separator(app)?,
            &MenuItem::with_id(app, SETTINGS_ID, "设置…", true, Some("CmdOrCtrl+,"))?,
            &PredefinedMenuItem::separator(app)?,
            &PredefinedMenuItem::services(app, Some("服务"))?,
            &PredefinedMenuItem::separator(app)?,
            &PredefinedMenuItem::hide(app, Some("隐藏 Farfold"))?,
            &PredefinedMenuItem::hide_others(app, Some("隐藏其他"))?,
            &PredefinedMenuItem::show_all(app, Some("全部显示"))?,
            &PredefinedMenuItem::separator(app)?,
            &MenuItem::with_id(app, QUIT_ID, "退出 Farfold", true, Some("CmdOrCtrl+Q"))?,
        ],
    )?;
    let file = Submenu::with_items(
        app,
        "文件",
        true,
        &[
            &MenuItem::with_id(app, NEW_ID, "新对话", true, Some("CmdOrCtrl+N"))?,
            &MenuItem::with_id(app, SEARCH_ID, "搜索对话", true, Some("CmdOrCtrl+K"))?,
            &PredefinedMenuItem::separator(app)?,
            &PredefinedMenuItem::close_window(app, Some("关闭窗口"))?,
        ],
    )?;
    // Predefined editing items keep native text editing working everywhere.
    let edit = Submenu::with_items(
        app,
        "编辑",
        true,
        &[
            &PredefinedMenuItem::undo(app, Some("撤销"))?,
            &PredefinedMenuItem::redo(app, Some("重做"))?,
            &PredefinedMenuItem::separator(app)?,
            &PredefinedMenuItem::cut(app, Some("剪切"))?,
            &PredefinedMenuItem::copy(app, Some("拷贝"))?,
            &PredefinedMenuItem::paste(app, Some("粘贴"))?,
            &PredefinedMenuItem::select_all(app, Some("全选"))?,
        ],
    )?;
    let view = Submenu::with_items(
        app,
        "显示",
        true,
        &[
            &MenuItem::with_id(app, TOGGLE_SIDEBAR_ID, "显示或隐藏侧栏", true, None::<&str>)?,
            &PredefinedMenuItem::fullscreen(app, Some("进入全屏幕"))?,
        ],
    )?;
    let window = Submenu::with_items(
        app,
        "窗口",
        true,
        &[
            &PredefinedMenuItem::minimize(app, Some("最小化"))?,
            &PredefinedMenuItem::maximize(app, Some("缩放"))?,
            &PredefinedMenuItem::separator(app)?,
            &PredefinedMenuItem::bring_all_to_front(app, Some("前置全部窗口"))?,
        ],
    )?;
    #[cfg(target_os = "macos")]
    window.set_as_windows_menu_for_nsapp()?;
    let help = Submenu::with_items(
        app,
        "帮助",
        true,
        &[
            &MenuItem::with_id(app, SHORTCUTS_ID, "键盘快捷键", true, None::<&str>)?,
            &MenuItem::with_id(app, PRIVACY_ID, "数据与隐私", true, None::<&str>)?,
        ],
    )?;
    #[cfg(target_os = "macos")]
    help.set_as_help_menu_for_nsapp()?;
    Menu::with_items(app, &[&application, &file, &edit, &view, &window, &help])
}

fn dispatch(id: &str, quit: impl FnOnce(), emit: impl FnOnce(&'static str)) {
    if id == QUIT_ID {
        quit();
        return;
    }
    if let Some(action) = action(id) {
        emit(action);
    }
}

pub(crate) fn handle<R: Runtime>(app: &AppHandle<R>, event: MenuEvent) {
    dispatch(
        event.id().as_ref(),
        || app.exit(0),
        |action| {
            let _ = app.emit("app-menu", serde_json::json!({ "action": action }));
        },
    );
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn quit_exits_normally_without_emitting() {
        let mut quits = 0;
        let mut emitted = Vec::new();
        dispatch(QUIT_ID, || quits += 1, |action| emitted.push(action));
        assert_eq!(quits, 1);
        assert!(emitted.is_empty());
    }

    #[test]
    fn owned_ids_emit_exactly_their_action() {
        for (id, expected) in OWNED {
            let mut quits = 0;
            let mut emitted = Vec::new();
            dispatch(id, || quits += 1, |action| emitted.push(action));
            assert_eq!(quits, 0, "{id} must not quit");
            assert_eq!(emitted.as_slice(), [*expected], "{id} action mismatch");
        }
    }

    #[test]
    fn unrelated_ids_are_ignored() {
        for unrelated in [
            "",
            "quit",
            "copy",
            "farfold.menu",
            "farfold.menu.unknown",
            "farfold.quit-after-save-extra",
        ] {
            dispatch(
                unrelated,
                || panic!("unrelated menu item must not exit"),
                |_| panic!("unrelated menu item must not emit"),
            );
        }
    }
}
