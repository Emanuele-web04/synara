//! A web view showing a URL.

use gpui::{div, prelude::*, AnyElement, Window};
use react_native_gpui::native_surface::{NativeViewHandle, NativeViewParent, Result};

#[cfg(target_os = "macos")]
use crate::appkit;
#[cfg(target_os = "linux")]
use crate::linux::LinuxWebView;
use crate::{SynaraWebViewChanged, SynaraWebViewContext, SynaraWebViewProps, SynaraWebViewSpec};

/// A web view showing a URL.
pub struct WebView {
    view: Option<NativeViewHandle>,
    url: String,
    #[cfg(target_os = "linux")]
    linux: Option<LinuxWebView>,
}

impl SynaraWebViewSpec for WebView {
    fn create(_props: &SynaraWebViewProps, _cx: &mut SynaraWebViewContext) -> Self {
        Self {
            view: None,
            url: String::new(),
            #[cfg(target_os = "linux")]
            linux: None,
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

    /// Linux: a child X11 window the backend reparents a browser window into.
    /// The window exists even before the browser lands, so the native view is
    /// real from the start.
    #[cfg(target_os = "linux")]
    fn create_view(
        &mut self,
        props: &SynaraWebViewProps,
        parent: &NativeViewParent<'_>,
        _window: &mut Window,
        _cx: &mut SynaraWebViewContext,
    ) -> Result<NativeViewHandle> {
        let view = LinuxWebView::create(parent, props.url())?;
        let handle = view.handle();
        self.linux = Some(view);
        self.view = Some(handle);
        self.url = props.url().to_string();
        Ok(handle)
    }

    #[cfg(target_os = "linux")]
    fn update_view(
        &mut self,
        _view: NativeViewHandle,
        props: &SynaraWebViewProps,
        changed: SynaraWebViewChanged,
        _cx: &mut SynaraWebViewContext,
    ) {
        if changed.url() {
            self.url = props.url().to_string();
            if let Some(view) = &self.linux {
                view.set_url(&self.url);
            }
        }
    }

    #[cfg(not(any(target_os = "macos", target_os = "linux")))]
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
