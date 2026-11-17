//! A web view showing a URL.

use gpui::{div, prelude::*, AnyElement, Window};
use react_native_gpui::native_surface::{NativeViewHandle, NativeViewParent, Result};

#[cfg(target_os = "macos")]
use crate::appkit;
use crate::{
    SynaraWebViewChanged, SynaraWebViewContext, SynaraWebViewProps, SynaraWebViewSpec,
};

/// A web view showing a URL.
pub struct WebView {
    view: Option<NativeViewHandle>,
    url: String,
}

impl SynaraWebViewSpec for WebView {
    fn create(_props: &SynaraWebViewProps, _cx: &mut SynaraWebViewContext) -> Self {
        Self {
            view: None,
            url: String::new(),
        }
    }

    fn update(
        &mut self,
        _props: &SynaraWebViewProps,
        _changed: SynaraWebViewChanged,
        _cx: &mut SynaraWebViewContext,
    ) {
    }

    fn render(
        &mut self,
        _props: &SynaraWebViewProps,
        _window: &mut Window,
        _cx: &mut SynaraWebViewContext,
    ) -> AnyElement {
        div().size_full().into_any_element()
    }

    #[cfg(target_os = "macos")]
    fn create_view(
        &mut self,
        props: &SynaraWebViewProps,
        _parent: &NativeViewParent<'_>,
        _window: &mut Window,
        _cx: &mut SynaraWebViewContext,
    ) -> Result<NativeViewHandle> {
        let view = appkit::web_view();
        self.view = Some(view);
        self.url = props.url().to_string();
        appkit::load_url(view, &self.url);
        Ok(view)
    }

    #[cfg(not(target_os = "macos"))]
    fn create_view(
        &mut self,
        _props: &SynaraWebViewProps,
        _parent: &NativeViewParent<'_>,
        _window: &mut Window,
        _cx: &mut SynaraWebViewContext,
    ) -> Result<NativeViewHandle> {
        Err(react_native_gpui::native_surface::Error::msg(
            "no OS view on this platform",
        ))
    }

    #[cfg(target_os = "macos")]
    fn update_view(
        &mut self,
        view: NativeViewHandle,
        props: &SynaraWebViewProps,
        changed: SynaraWebViewChanged,
        _cx: &mut SynaraWebViewContext,
    ) {
        if changed.url() {
            self.url = props.url().to_string();
            appkit::load_url(view, &self.url);
        }
    }
}
