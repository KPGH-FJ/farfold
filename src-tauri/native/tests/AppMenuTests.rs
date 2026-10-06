use std::borrow::Cow;
use tauri::utils::{
    acl::resolved::Resolved,
    assets::{AssetKey, AssetsIter, CspHash},
    config::Config,
};
use tauri::{Assets, Context, PackageInfo, Pattern, Runtime};
struct EmptyAssets;
impl<R: Runtime> Assets<R> for EmptyAssets {
    fn get(&self, _: &AssetKey) -> Option<Cow<'_, [u8]>> {
        None
    }
    fn iter(&self) -> Box<AssetsIter<'_>> {
        Box::new(std::iter::empty())
    }
    fn csp_hashes(&self, _: &AssetKey) -> Box<dyn Iterator<Item = CspHash<'_>> + '_> {
        Box::new(std::iter::empty())
    }
}
#[path = "../../src/app_menu.rs"]
mod app_menu;
fn main() {
    let mut config = Config::default();
    config.app.windows.clear();
    let context = Context::new(
        config,
        Box::new(EmptyAssets),
        None,
        None,
        PackageInfo {
            name: "Farfold".into(),
            version: "0.1.7".parse().unwrap(),
            authors: "Farfold",
            description: "Controlled menu-only peer",
            crate_name: "quit_entry_peer",
        },
        Pattern::Brownfield,
        tauri::runtime_authority!(Default::default(), Resolved::default()),
        None,
    );
    let app = tauri::Builder::default()
        .enable_macos_default_menu(false)
        .build(context)
        .unwrap();
    let baseline = tauri::menu::Menu::default(app.handle()).unwrap();
    let standard = baseline.items().unwrap();
    let menu = app_menu::create(app.handle()).unwrap();
    let root = menu.items().unwrap();
    let application = root[0].as_submenu().unwrap();
    let children = application.items().unwrap();
    assert!(
        matches!(
            children.last(),
            Some(tauri::menu::MenuItemKind::MenuItem(_))
        ),
        "quit must be an ordinary menu item, not native terminate"
    );
    assert_eq!(root.len(), standard.len());
    for (a, b) in root.iter().skip(1).zip(standard.iter().skip(1)) {
        assert_eq!(
            a.as_submenu().unwrap().text().unwrap(),
            b.as_submenu().unwrap().text().unwrap()
        );
        assert_eq!(
            a.as_submenu().unwrap().items().unwrap().len(),
            b.as_submenu().unwrap().items().unwrap().len()
        );
    }
    assert_eq!(children.len(), 8);
    let quit = children.last().unwrap().as_menuitem().unwrap();
    assert_eq!(quit.id().as_ref(), "farfold.quit-after-save");
    assert!(quit.is_enabled().unwrap());
    menu.set_as_app_menu().unwrap(); // Only this peer's unlaunched application.
    unsafe {
        let application = send_id(
            objc_getClass(c"NSApplication".as_ptr()),
            selector(b"sharedApplication\0"),
        );
        let ns = send_id(application, selector(b"mainMenu\0"));
        let app_item = send_index(ns, selector(b"itemAtIndex:\0"), 0);
        let submenu = send_id(app_item, selector(b"submenu\0"));
        let quit_item = send_index(submenu, selector(b"itemAtIndex:\0"), 7);
        assert_ne!(
            send_id(quit_item, selector(b"action\0")),
            selector(b"terminate:\0")
        );
        assert_eq!(
            send_id(quit_item, selector(b"action\0")),
            selector(b"fireMenuItemAction:\0")
        );
        let equivalent = send_id(quit_item, selector(b"keyEquivalent\0"));
        let key = send_id(equivalent, selector(b"UTF8String\0")) as *const std::ffi::c_char;
        assert_eq!(std::ffi::CStr::from_ptr(key).to_bytes(), b"q");
        let modifiers = send_usize(quit_item, selector(b"keyEquivalentModifierMask\0"));
        assert_ne!(modifiers & (1 << 20), 0);
    }
    let _registered_handler = app_menu::handle::<tauri::Wry>;
    println!(
        "native menu guarded quit passed; root={} application={}; ordinary action/CmdQ/standard submenus preserved",
        root.len(),
        children.len()
    );
}

#[link(name = "objc")]
unsafe extern "C" {
    fn objc_getClass(name: *const std::ffi::c_char) -> *mut std::ffi::c_void;
    fn sel_registerName(name: *const std::ffi::c_char) -> *mut std::ffi::c_void;
    fn objc_msgSend();
}
unsafe fn send_usize(object: *mut std::ffi::c_void, sel: *mut std::ffi::c_void) -> usize {
    let f: unsafe extern "C" fn(*mut std::ffi::c_void, *mut std::ffi::c_void) -> usize =
        unsafe { std::mem::transmute(objc_msgSend as *const ()) };
    unsafe { f(object, sel) }
}
unsafe fn selector(s: &[u8]) -> *mut std::ffi::c_void {
    unsafe { sel_registerName(s.as_ptr().cast()) }
}
unsafe fn send_id(
    object: *mut std::ffi::c_void,
    sel: *mut std::ffi::c_void,
) -> *mut std::ffi::c_void {
    let f: unsafe extern "C" fn(
        *mut std::ffi::c_void,
        *mut std::ffi::c_void,
    ) -> *mut std::ffi::c_void = unsafe { std::mem::transmute(objc_msgSend as *const ()) };
    unsafe { f(object, sel) }
}
unsafe fn send_index(
    object: *mut std::ffi::c_void,
    sel: *mut std::ffi::c_void,
    index: usize,
) -> *mut std::ffi::c_void {
    let f: unsafe extern "C" fn(
        *mut std::ffi::c_void,
        *mut std::ffi::c_void,
        usize,
    ) -> *mut std::ffi::c_void = unsafe { std::mem::transmute(objc_msgSend as *const ()) };
    unsafe { f(object, sel, index) }
}
