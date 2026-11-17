//! The Linux web view: an in-process WebKitGTK web view (via `wry`) inside an
//! X11 child window under the composition surface.
//!
//! GTK is single-threaded and `gtk::init` must run before any wry call, so a
//! dedicated thread owns the GTK main loop and every web view operation is
//! posted to it. The component's own child window stays the tracked native
//! view; wry creates its container inside it. A 250 ms poll keeps the web
//! view's bounds in sync with the child window's geometry, which the
//! compositor moves and resizes with the surface.
//!
//! Hardening: WebKitGTK sandboxes its web processes through bubblewrap when
//! available; devtools are off, navigation is limited to http/https/about,
//! `window.open` and downloads are denied, and sensor permissions
//! (microphone, camera, geolocation) are refused.

use std::{
    cell::RefCell,
    collections::HashMap,
    sync::{
        atomic::{AtomicBool, Ordering},
        mpsc, Mutex, Once,
    },
    thread,
    time::Duration,
};

use raw_window_handle::{
    HandleError, HasWindowHandle, RawWindowHandle, WindowHandle, XlibWindowHandle,
};
use react_native_gpui::native_surface::{Error, NativeViewHandle, NativeViewParent, Result};
use wry::{
    dpi::{LogicalPosition, LogicalSize},
    NewWindowResponse, PermissionKind, PermissionResponse, Rect, WebView, WebViewBuilder,
};
use x11rb::{
    connection::Connection,
    protocol::xproto::{
        ConfigureWindowAux, ConnectionExt, CreateWindowAux, EventMask, WindowClass,
    },
    rust_connection::RustConnection,
    COPY_DEPTH_FROM_PARENT, COPY_FROM_PARENT,
};

/// How often the GTK thread reconciles each web view's bounds with its
/// window's geometry and drops views whose window is gone.
const POLL: Duration = Duration::from_millis(250);

/// A web view living on the GTK thread, keyed by the child window id that
/// hosts it.
struct View {
    webview: WebView,
    /// The composition surface our child window lives under; its geometry is
    /// what the web view must match.
    surface: u32,
    width: u32,
    height: u32,
}

thread_local! {
    static VIEWS: RefCell<HashMap<u32, View>> = RefCell::new(HashMap::new());
    /// The GTK thread's own X connection for geometry reads — GDK's foreign
    /// window wrapper does not report real geometry for windows we created.
    static XCONN: RefCell<Option<RustConnection>> = const { RefCell::new(None) };
}

/// The embedded web view. Dropping it destroys the web view on the GTK
/// thread and then the child window.
pub struct LinuxWebView {
    window: u32,
    gone: AtomicBool,
    conn: RustConnection,
}

/// `HasWindowHandle` over a raw X11 window id for `build_as_child` (wry reads
/// only `XlibWindowHandle::window`; the display comes from GDK).
struct XlibParent {
    window: std::os::raw::c_ulong,
}

impl HasWindowHandle for XlibParent {
    fn window_handle(&self) -> std::result::Result<WindowHandle<'_>, HandleError> {
        // SAFETY: `window` is our child X11 window, alive for the borrow's
        // lifetime (the caller holds it until `build_as_child` returns).
        Ok(unsafe {
            WindowHandle::borrow_raw(RawWindowHandle::Xlib(XlibWindowHandle::new(self.window)))
        })
    }
}

impl LinuxWebView {
    /// Creates the child window under `parent`'s surface window and builds
    /// the WebKitGTK web view inside it on the GTK thread.
    pub fn create(parent: &NativeViewParent<'_>, url: &str) -> Result<Self> {
        let surface = match parent.raw_window_handle()? {
            RawWindowHandle::Xcb(handle) => handle.window.get(),
            _ => return Err(Error::msg("composition surface is not an X11 window")),
        };

        let (conn, _screen) =
            RustConnection::connect(None).map_err(|e| Error::msg(format!("X connect: {e}")))?;
        let geometry = conn
            .get_geometry(surface)
            .map_err(|e| Error::msg(format!("X get geometry: {e}")))?
            .reply()
            .map_err(|e| Error::msg(format!("X get geometry reply: {e}")))?;
        let (width, height) = (
            u32::from(geometry.width).max(1),
            u32::from(geometry.height).max(1),
        );
        let window = conn
            .generate_id()
            .map_err(|e| Error::msg(format!("X generate id: {e}")))?;
        conn.create_window(
            COPY_DEPTH_FROM_PARENT,
            window,
            surface,
            0,
            0,
            width as u16,
            height as u16,
            0,
            WindowClass::INPUT_OUTPUT,
            COPY_FROM_PARENT,
            &CreateWindowAux::new()
                .background_pixel(0)
                .event_mask(EventMask::EXPOSURE | EventMask::STRUCTURE_NOTIFY),
        )
        .map_err(|e| Error::msg(format!("X create window: {e}")))?;
        conn.map_window(window)
            .map_err(|e| Error::msg(format!("X map window: {e}")))?;
        conn.flush()
            .map_err(|e| Error::msg(format!("X flush: {e}")))?;

        if let Err(e) = ensure_gtk().and_then(|()| build_view(surface, window, url, width, height))
        {
            let _ = conn.destroy_window(window);
            let _ = conn.flush();
            return Err(e);
        }

        Ok(Self {
            window,
            gone: AtomicBool::new(false),
            conn,
        })
    }

    /// The child window the web view lives in.
    pub fn handle(&self) -> NativeViewHandle {
        NativeViewHandle::from_x11_window(self.window)
    }

    /// Loads a different URL in the running web view.
    pub fn set_url(&self, url: &str) {
        if self.gone.load(Ordering::SeqCst) {
            return;
        }
        let window = self.window;
        let url = url.to_string();
        glib::idle_add_once(move || {
            VIEWS.with(|views| {
                if let Some(view) = views.borrow().get(&window) {
                    let _ = view.webview.load_url(&url);
                }
            });
        });
    }
}

impl Drop for LinuxWebView {
    fn drop(&mut self) {
        self.gone.store(true, Ordering::SeqCst);
        let window = self.window;
        let (tx, rx) = mpsc::channel();
        glib::idle_add_once(move || {
            VIEWS.with(|views| {
                views.borrow_mut().remove(&window);
            });
            let _ = tx.send(());
        });
        // Let the GTK thread drop the web view while its container window is
        // still alive, then destroy the window (and the container subtree).
        let _ = rx.recv_timeout(Duration::from_millis(500));
        let _ = self.conn.destroy_window(self.window);
        let _ = self.conn.flush();
    }
}

/// Starts the dedicated GTK thread once and reports `gtk::init`'s result.
fn ensure_gtk() -> Result<()> {
    static STARTED: Once = Once::new();
    static INIT: Mutex<Option<Result<()>>> = Mutex::new(None);
    STARTED.call_once(|| {
        let (tx, rx) = mpsc::channel();
        let tx_err = tx.clone();
        if let Err(e) = thread::Builder::new()
            .name("synara-webview-gtk".into())
            .spawn(move || {
                // Software compositing: no GPU driver, GBM or DMA-BUF buffers
                // are touched, which keeps the web view working (and less
                // exposed) on VMs and systems without working EGL.
                if std::env::var_os("WEBKIT_DISABLE_COMPOSITING_MODE").is_none() {
                    unsafe {
                        libc::setenv(
                            c"WEBKIT_DISABLE_COMPOSITING_MODE".as_ptr(),
                            c"1".as_ptr(),
                            0,
                        )
                    };
                }
                if std::env::var_os("WEBKIT_DISABLE_DMABUF_RENDERER").is_none() {
                    unsafe {
                        libc::setenv(c"WEBKIT_DISABLE_DMABUF_RENDERER".as_ptr(), c"1".as_ptr(), 0)
                    };
                }
                let init = gtk::init().map_err(|e| Error::msg(format!("gtk::init: {e}")));
                let ok = init.is_ok();
                let _ = tx.send(init);
                if ok {
                    glib::timeout_add(POLL, poll_views);
                    gtk::main();
                }
            })
        {
            let _ = tx_err.send(Err(Error::msg(format!("gtk thread: {e}"))));
        }
        let result = rx
            .recv()
            .unwrap_or_else(|_| Err(Error::msg("gtk thread stopped before gtk::init finished")));
        *INIT.lock().unwrap() = Some(result);
    });
    match &*INIT.lock().unwrap() {
        Some(Ok(())) => Ok(()),
        Some(Err(e)) => Err(Error::msg(e.to_string())),
        None => Err(Error::msg("gtk::init did not complete")),
    }
}

/// Builds the web view inside `window` on the GTK thread and blocks until it
/// is up (or has failed).
fn build_view(surface: u32, window: u32, url: &str, width: u32, height: u32) -> Result<()> {
    let (tx, rx) = mpsc::channel();
    let url = url.to_string();
    glib::idle_add_once(move || {
        let _ = tx.send(build_view_on_gtk(surface, window, &url, width, height));
    });
    rx.recv()
        .unwrap_or_else(|_| Err(Error::msg("gtk thread stopped during web view setup")))
}

/// Runs on the GTK thread: builds the hardened WebKitGTK web view under
/// `window`.
fn build_view_on_gtk(surface: u32, window: u32, url: &str, width: u32, height: u32) -> Result<()> {
    let parent = XlibParent {
        window: window as std::os::raw::c_ulong,
    };
    let webview = WebViewBuilder::new()
        .with_url(url)
        .with_bounds(Rect {
            position: LogicalPosition::new(0, 0).into(),
            size: LogicalSize::new(width as f64, height as f64).into(),
        })
        .with_devtools(false)
        .with_navigation_handler(|uri| {
            uri.starts_with("http://") || uri.starts_with("https://") || uri.starts_with("about:")
        })
        .with_new_window_req_handler(|_, _| NewWindowResponse::Deny)
        .with_download_started_handler(|_, _| false)
        .with_permission_handler(|kind| match kind {
            PermissionKind::Microphone | PermissionKind::Camera | PermissionKind::Geolocation => {
                PermissionResponse::Deny
            }
            _ => PermissionResponse::Allow,
        })
        .build_as_child(&parent)
        .map_err(|e| Error::msg(format!("web view: {e}")))?;
    VIEWS.with(|views| {
        views.borrow_mut().insert(
            window,
            View {
                webview,
                surface,
                width,
                height,
            },
        );
    });
    Ok(())
}

/// The GTK thread's X connection, opened on first use.
fn with_xconn(f: impl FnOnce(&RustConnection)) {
    XCONN.with(|slot| {
        let mut slot = slot.borrow_mut();
        if slot.is_none() {
            *slot = RustConnection::connect(None).map(|(conn, _)| conn).ok();
        }
        if let Some(conn) = slot.as_ref() {
            f(conn);
        }
    });
}

/// GTK-thread poll: keeps each child window sized to its surface (the
/// surface may still be tiny when the component mounts), resizes the web
/// view to match, and drops views whose window no longer exists.
fn poll_views() -> glib::ControlFlow {
    with_xconn(|conn| {
        VIEWS.with(|views| {
            let surfaces: Vec<(u32, Option<(u32, u32)>)> = views
                .borrow()
                .iter()
                .map(|(window, view)| {
                    let size = conn
                        .get_geometry(view.surface)
                        .ok()
                        .and_then(|cookie| cookie.reply().ok())
                        .map(|geo| (u32::from(geo.width), u32::from(geo.height)));
                    (*window, size)
                })
                .collect();
            views.borrow_mut().retain(|window, view| {
                let Some((width, height)) = surfaces
                    .iter()
                    .find(|(id, _)| id == window)
                    .and_then(|(_, size)| *size)
                else {
                    return false;
                };
                if (width, height) != (view.width, view.height) {
                    view.width = width;
                    view.height = height;
                    let _ = conn.configure_window(
                        *window,
                        &ConfigureWindowAux::new()
                            .x(0)
                            .y(0)
                            .width(width)
                            .height(height),
                    );
                    let _ = view.webview.set_bounds(Rect {
                        position: LogicalPosition::new(0, 0).into(),
                        size: LogicalSize::new(width as f64, height as f64).into(),
                    });
                }
                true
            });
            let _ = conn.flush();
        });
    });
    glib::ControlFlow::Continue
}
