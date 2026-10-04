//! Standalone probe context for the cached Tauri 2.11.5 runtime.
//! This module reads no configuration, assets, profiles, or application data.
//! Context::new is public but documented by Tauri as an unstable API;
//! keep this hand-written context confined to the version-pinned probe.

use std::borrow::Cow;
use tauri::utils::assets::{AssetKey, AssetsIter, CspHash};
use tauri::utils::config::{Config, Csp};
use tauri::{Assets, Context, PackageInfo, Pattern, Wry};

const HTML: &[u8] = concat!("<!doctype html><html lang='zh'><head><meta charset='utf-8'><title>Controlled React layout</title><style>",include_str!("ui-dist/app.css"),"</style></head><body><div id='root'></div></body></html>").as_bytes();

struct ProbeAssets;

impl Assets<Wry> for ProbeAssets {
    fn get(&self, key: &AssetKey) -> Option<Cow<'_, [u8]>> {
        match key.as_ref() {
            "/" | "/index.html" => Some(Cow::Borrowed(HTML)),
            _ => None,
        }
    }

    fn iter(&self) -> Box<AssetsIter<'_>> {
        Box::new(std::iter::once((
            Cow::Borrowed("/index.html"),
            Cow::Borrowed(HTML),
        )))
    }

    fn csp_hashes(&self, _html_path: &AssetKey) -> Box<dyn Iterator<Item = CspHash<'_>> + '_> {
        Box::new(std::iter::empty())
    }
}

pub fn context() -> Context<Wry> {
    let mut config = Config::default();
    config.identifier = "ai.farfold.desktop".into();
    config.product_name = Some("CommandProbe".into());
    // Create the one incognito "main" window explicitly in the probe setup.
    config.app.windows.clear();
    config.app.with_global_tauri = false;
    // No HTTP(S), WebSocket, frame, form, image, stylesheet or font destinations.
    // ipc: is the in-process Tauri transport, not a network endpoint.
    let csp = Csp::Policy(
        "default-src 'none'; connect-src ipc:; script-src 'none'; style-src 'unsafe-inline'; img-src 'none'; frame-src 'none'; form-action 'none'; base-uri 'none'; object-src 'none'".into(),
    );
    config.app.security.csp = Some(csp.clone());
    config.app.security.dev_csp = Some(csp);
    config.plugins.0.clear();
    // No generate_context! / build output / production capability files are read.
    // The caller registers unchanged production browser commands plus synthetic evidence helpers; guard main+local.
    let authority = tauri::runtime_authority!(
        Default::default(),
        tauri::utils::acl::resolved::Resolved::default()
    );
    Context::new(
        config,
        Box::new(ProbeAssets),
        None,
        None,
        PackageInfo {
            name: "CommandProbe".into(),
            version: "0.0.0".parse().expect("constant probe version"),
            authors: "Isolated command probe",
            description: "Isolated Tauri WebKit seam validation",
            crate_name: "command_probe",
        },
        Pattern::Brownfield,
        authority,
        None,
    )
}
