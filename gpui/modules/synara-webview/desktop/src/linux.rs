//! The Linux web view: an X11 child window under the composition surface,
//! with a Chromium-family browser window reparented into it.
//!
//! GPUI on Linux has no in-process web view, so the component embeds a real
//! browser process. The browser runs chromeless (`--app=<url>`) in an
//! isolated profile with a unique `--class`, so its window can be found and
//! reparented under the child no matter how the browser's launcher re-execs.
//! A watcher thread keeps the browser's geometry in sync with the surface and
//! kills it when the host window or the component goes away.

use std::{
    process::{Child, Command, Stdio},
    sync::{
        atomic::{AtomicBool, Ordering},
        Arc, Mutex,
    },
    thread,
    time::Duration,
};

use raw_window_handle::RawWindowHandle;
use react_native_gpui::native_surface::{Error, NativeViewHandle, NativeViewParent, Result};
use x11rb::{
    connection::Connection,
    protocol::xproto::{
        AtomEnum, ConfigureWindowAux, ConnectionExt, CreateWindowAux, EventMask, WindowClass,
    },
    rust_connection::RustConnection,
    COPY_DEPTH_FROM_PARENT, COPY_FROM_PARENT,
};

/// A Chromium-family executable, in PATH-preference order. The
/// `SYNARA_WEBVIEW_BROWSER` environment variable overrides the search.
const BROWSERS: &[&str] = &[
    "google-chrome",
    "google-chrome-stable",
    "chromium",
    "chromium-browser",
    "microsoft-edge",
];

/// How often the watcher reconciles the browser's geometry and checks the
/// host window still exists.
const POLL: Duration = Duration::from_millis(200);

/// How many polls the watcher looks for a new browser window before giving up
/// on that launch and restarting it (~20 s).
const FIND_WINDOW_POLLS: u32 = 100;

/// The embedded web view. Dropping it stops the watcher, kills the browser
/// and destroys the child window.
pub struct LinuxWebView {
    window: u32,
    url: Arc<Mutex<String>>,
    stop: Arc<AtomicBool>,
    browser: Arc<Mutex<Option<Child>>>,
    conn: RustConnection,
    watcher: Option<thread::JoinHandle<()>>,
}

impl LinuxWebView {
    /// Creates the child window under `parent`'s surface window and starts
    /// the watcher that launches and embeds the browser for `url`.
    pub fn create(parent: &NativeViewParent<'_>, url: &str) -> Result<Self> {
        let surface = match parent.raw_window_handle()? {
            RawWindowHandle::Xcb(handle) => handle.window.get(),
            _ => return Err(Error::msg("composition surface is not an X11 window")),
        };

        let (conn, _screen) =
            RustConnection::connect(None).map_err(|e| Error::msg(format!("X connect: {e}")))?;
        let window = conn
            .generate_id()
            .map_err(|e| Error::msg(format!("X generate id: {e}")))?;
        conn.create_window(
            COPY_DEPTH_FROM_PARENT,
            window,
            surface,
            0,
            0,
            1,
            1,
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

        let url = Arc::new(Mutex::new(url.to_string()));
        let stop = Arc::new(AtomicBool::new(false));
        let browser = Arc::new(Mutex::new(None));
        let watcher = {
            let url = url.clone();
            let stop = stop.clone();
            let browser = browser.clone();
            thread::Builder::new()
                .name("synara-webview".into())
                .spawn(move || watch(surface, window, url, stop, browser))
                .map_err(|e| Error::msg(format!("webview watcher: {e}")))?
        };

        Ok(Self {
            window,
            url,
            stop,
            browser,
            conn,
            watcher: Some(watcher),
        })
    }

    /// The child window the browser is reparented into.
    pub fn handle(&self) -> NativeViewHandle {
        NativeViewHandle::from_x11_window(self.window)
    }

    /// Loads a different URL: the watcher restarts the browser with it.
    pub fn set_url(&self, url: &str) {
        if let Ok(mut current) = self.url.lock() {
            *current = url.to_string();
        }
    }
}

impl Drop for LinuxWebView {
    fn drop(&mut self) {
        self.stop.store(true, Ordering::SeqCst);
        if let Some(watcher) = self.watcher.take() {
            let _ = watcher.join();
        }
        kill_browser(None, &self.browser, &mut None);
        let _ = self.conn.destroy_window(self.window);
        let _ = self.conn.flush();
    }
}

/// Finds a browser executable: `SYNARA_WEBVIEW_BROWSER` first, then the
/// Chromium family in preference order.
fn browser_binary() -> Option<String> {
    if let Ok(custom) = std::env::var("SYNARA_WEBVIEW_BROWSER") {
        if !custom.is_empty() {
            return Some(custom);
        }
    }
    for name in BROWSERS {
        let found = Command::new("which")
            .arg(name)
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .status()
            .map(|status| status.success())
            .unwrap_or(false);
        if found {
            return Some((*name).to_string());
        }
    }
    None
}

/// Launches the browser as a chromeless `--app` window in an isolated
/// profile, tagged with `class` so its window is identifiable no matter how
/// the launcher re-execs the real browser process.
fn spawn_browser(binary: &str, class: &str, url: &str) -> Result<Child> {
    let profile = std::env::temp_dir().join(format!("synara-webview-{}", std::process::id()));
    Command::new(binary)
        .args([
            "--no-first-run",
            "--no-default-browser-check",
            "--disable-session-crashed-bubble",
            "--disable-features=TranslateUI",
            "--noerrdialogs",
            "--force-device-scale-factor=1",
            &format!("--user-data-dir={}", profile.display()),
            &format!("--class={class}"),
            &format!("--app={url}"),
        ])
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .spawn()
        .map_err(|e| Error::msg(format!("{binary}: {e}")))
}

/// Kills the spawned launcher and the real browser process — found through
/// the embedded window's `_NET_WM_PID`, since launchers re-exec.
fn kill_browser(
    conn: Option<&RustConnection>,
    browser: &Mutex<Option<Child>>,
    browser_window: &mut Option<u32>,
) {
    if let (Some(conn), Some(window)) = (conn, browser_window.take()) {
        if let Some(pid) = window_pid(conn, window) {
            // SAFETY/scope: pid owns the window we embedded, which is ours to
            // close. A SIGTERM lets the browser shut down its profile cleanly.
            unsafe {
                libc::kill(pid as i32, 15);
            }
        }
    }
    if let Ok(mut guard) = browser.lock() {
        if let Some(mut child) = guard.take() {
            let _ = child.kill();
            let _ = child.wait();
        }
    }
}

/// Interns `_NET_CLIENT_LIST` and `_NET_WM_PID` once.
fn net_atoms(conn: &RustConnection) -> Option<(u32, u32)> {
    let client_list = conn
        .intern_atom(false, b"_NET_CLIENT_LIST")
        .ok()?
        .reply()
        .ok()?
        .atom;
    let wm_pid = conn
        .intern_atom(false, b"_NET_WM_PID")
        .ok()?
        .reply()
        .ok()?
        .atom;
    Some((client_list, wm_pid))
}

/// The `_NET_WM_PID` of `window`, when set.
fn window_pid(conn: &RustConnection, window: u32) -> Option<u32> {
    let wm_pid = conn
        .intern_atom(false, b"_NET_WM_PID")
        .ok()?
        .reply()
        .ok()?
        .atom;
    let prop = conn
        .get_property(false, window, wm_pid, AtomEnum::CARDINAL, 0, 1)
        .ok()?
        .reply()
        .ok()?;
    let value = prop.value32()?.next();
    value
}

/// The mapped top-level window whose `WM_CLASS` contains `class`.
fn window_for_class(
    conn: &RustConnection,
    root: u32,
    client_list: u32,
    class: &str,
) -> Option<u32> {
    let list = conn
        .get_property(false, root, client_list, AtomEnum::WINDOW, 0, 2048)
        .ok()?
        .reply()
        .ok()?;
    for window in list.value32()? {
        let wm_class = conn
            .get_property(false, window, AtomEnum::WM_CLASS, AtomEnum::STRING, 0, 64)
            .ok()?
            .reply()
            .ok()?;
        let value = String::from_utf8_lossy(&wm_class.value);
        if value.split('\0').any(|part| part == class) {
            return Some(window);
        }
    }
    None
}

/// Embeds `browser_window` under `window` and sizes both to the surface.
fn embed_window(
    conn: &RustConnection,
    surface: u32,
    window: u32,
    browser_window: u32,
) -> Result<()> {
    let geometry = conn
        .get_geometry(surface)
        .map_err(|e| Error::msg(format!("X get geometry: {e}")))?
        .reply()
        .map_err(|e| Error::msg(format!("X get geometry reply: {e}")))?;
    let (width, height) = (u32::from(geometry.width), u32::from(geometry.height));
    let aux = ConfigureWindowAux::new()
        .x(0)
        .y(0)
        .width(width)
        .height(height);
    conn.configure_window(window, &aux)
        .map_err(|e| Error::msg(format!("X configure child: {e}")))?;
    conn.reparent_window(browser_window, window, 0, 0)
        .map_err(|e| Error::msg(format!("X reparent: {e}")))?;
    conn.configure_window(browser_window, &aux)
        .map_err(|e| Error::msg(format!("X configure browser: {e}")))?;
    conn.map_window(browser_window)
        .map_err(|e| Error::msg(format!("X map browser: {e}")))?;
    conn.flush()
        .map_err(|e| Error::msg(format!("X flush: {e}")))
}

/// Sizes `window` and `browser_window` to the surface's current geometry.
fn sync_geometry(conn: &RustConnection, surface: u32, window: u32, browser_window: Option<u32>) {
    let geometry = conn
        .get_geometry(surface)
        .ok()
        .and_then(|cookie| cookie.reply().ok());
    if let Some(geometry) = geometry {
        let aux = ConfigureWindowAux::new()
            .x(0)
            .y(0)
            .width(u32::from(geometry.width))
            .height(u32::from(geometry.height));
        let _ = conn.configure_window(window, &aux);
        if let Some(browser_window) = browser_window {
            let _ = conn.configure_window(browser_window, &aux);
        }
        let _ = conn.flush();
    }
}

/// Owns the browser lifecycle: (re)spawns on URL change, embeds the browser
/// window once it appears, keeps geometry in sync, and exits — killing the
/// browser — when asked or when the surface window is gone.
fn watch(
    surface: u32,
    window: u32,
    url: Arc<Mutex<String>>,
    stop: Arc<AtomicBool>,
    browser: Arc<Mutex<Option<Child>>>,
) {
    let Ok((conn, screen)) = RustConnection::connect(None) else {
        log::warn!("synara-webview: could not open an X connection");
        return;
    };
    let root = conn.setup().roots[screen].root;
    let Some((client_list, _)) = net_atoms(&conn) else {
        log::warn!("synara-webview: _NET_CLIENT_LIST unsupported by the window manager");
        return;
    };

    let Some(binary) = browser_binary() else {
        log::warn!(
            "synara-webview: no Chromium-family browser found; \
             install one or set SYNARA_WEBVIEW_BROWSER"
        );
        return;
    };

    // Unique WM_CLASS for this embedded instance.
    let class = format!("synara-webview-{}-{window}", std::process::id());
    let mut browser_window: Option<u32> = None;
    let mut loaded = String::new();
    let mut misses = 0u32;

    loop {
        if stop.load(Ordering::SeqCst) {
            break;
        }
        // The host destroyed the surface: nothing to embed in anymore.
        let surface_gone = conn
            .get_geometry(surface)
            .map(|c| c.reply().is_err())
            .unwrap_or(true);
        if surface_gone {
            break;
        }

        let wanted = url.lock().map(|u| u.clone()).unwrap_or_default();
        if wanted != loaded {
            kill_browser(Some(&conn), &browser, &mut browser_window);
            loaded.clone_from(&wanted);
            if !wanted.is_empty() {
                match spawn_browser(&binary, &class, &wanted) {
                    Ok(child) => {
                        *browser.lock().unwrap() = Some(child);
                        misses = 0;
                    }
                    Err(e) => {
                        log::warn!("synara-webview: {e}");
                        thread::sleep(POLL);
                        continue;
                    }
                }
            }
        }

        match browser_window {
            // The browser window can take a few seconds to appear.
            None if !loaded.is_empty() => {
                match window_for_class(&conn, root, client_list, &class) {
                    Some(found) => match embed_window(&conn, surface, window, found) {
                        Ok(()) => browser_window = Some(found),
                        Err(e) => log::warn!("synara-webview: {e}"),
                    },
                    None => {
                        misses += 1;
                        if misses >= FIND_WINDOW_POLLS {
                            log::warn!("synara-webview: browser window never appeared; restarting");
                            kill_browser(Some(&conn), &browser, &mut browser_window);
                            loaded.clear();
                        }
                    }
                }
            }
            Some(embedded) => {
                // The browser can close or crash its window: respawn then.
                let gone = conn
                    .get_geometry(embedded)
                    .map(|c| c.reply().is_err())
                    .unwrap_or(true);
                if gone {
                    browser_window = None;
                    kill_browser(Some(&conn), &browser, &mut browser_window);
                    loaded.clear();
                } else {
                    sync_geometry(&conn, surface, window, Some(embedded));
                }
            }
            None => {}
        }

        thread::sleep(POLL);
    }

    kill_browser(Some(&conn), &browser, &mut browser_window);
}
