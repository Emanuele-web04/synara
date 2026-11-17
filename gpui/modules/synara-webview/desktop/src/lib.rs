//! The Synara shell's host components.

rn_gpui_module::include_specs!();

#[cfg(target_os = "macos")]
mod appkit;
mod webview;

use react_native_gpui::host_component::register_component;

/// Registers the components. Autolink calls this through the crate's
/// `rn_gpui_register()`, exactly like a published package.
pub fn rn_gpui_register() {
    register_component(synara_web_view_component::<webview::WebView>());
}
