//! The Windows web view: an in-process WebView2 composition controller whose
//! root visual is the composition surface's own `IDCompositionVisual`.
//!
//! The compositor places, clips and hides the surface's visual, so the native
//! view reports `composited` and the WebView's visual tree rides along with no
//! child window to track — `composited` is what this platform asks native
//! components to return.
//!
//! Every WebView2 call happens on one dedicated STA thread with a message
//! pump: the interfaces are single-threaded and the pump is what delivers the
//! async completion callbacks. A poll on the same thread reads the surface
//! visual's clip rectangle — which the compositor updates every frame — and
//! keeps `put_Bounds`/`put_IsVisible` in sync with it, the same way the Linux
//! backend polls its X11 child window's geometry.
//!
//! Input: mouse and scroll events must be forwarded to the composition
//! controller, so `element` returns a div wired to `SendMouseInput`. Keyboard
//! input needs no forwarding: WebView2 takes focus on a pressed event and the
//! OS then routes keyboard input to it directly (documented behavior of the
//! composition controller).
//!
//! Hardening mirrors the Linux backend: devtools off, host objects and script
//! dialogs off, navigation limited to http/https/about, `window.open` and
//! downloads denied, and mic/camera/geolocation refused.

use std::{
    cell::RefCell,
    collections::HashMap,
    sync::{
        atomic::{AtomicBool, AtomicU64, Ordering},
        mpsc,
        mpsc::{Receiver, Sender},
        Arc, Mutex, Once,
    },
    thread,
    time::Duration,
};

use gpui::{canvas, div, prelude::*, AnyElement, MouseButton, NavigationDirection, Window};
use raw_window_handle::{HasWindowHandle, RawWindowHandle};
use react_native_gpui::native_surface::{Error, NativeViewHandle, NativeViewParent, Result};
use webview2_com::Microsoft::Web::WebView2::Win32::{
    CoreWebView2EnvironmentOptions, CreateCoreWebView2EnvironmentWithOptions, ICoreWebView2,
    ICoreWebView2CompositionController, ICoreWebView2CompositionController3,
    ICoreWebView2Controller, ICoreWebView2Environment, ICoreWebView2EnvironmentOptions,
    ICoreWebView2Settings3, ICoreWebView2_4, COREWEBVIEW2_BOUNDS_MODE_USE_RAW_PIXELS,
    COREWEBVIEW2_MOUSE_EVENT_KIND, COREWEBVIEW2_MOUSE_EVENT_KIND_HORIZONTAL_WHEEL,
    COREWEBVIEW2_MOUSE_EVENT_KIND_LEAVE, COREWEBVIEW2_MOUSE_EVENT_KIND_LEFT_BUTTON_DOWN,
    COREWEBVIEW2_MOUSE_EVENT_KIND_LEFT_BUTTON_UP, COREWEBVIEW2_MOUSE_EVENT_KIND_MIDDLE_BUTTON_DOWN,
    COREWEBVIEW2_MOUSE_EVENT_KIND_MIDDLE_BUTTON_UP, COREWEBVIEW2_MOUSE_EVENT_KIND_MOVE,
    COREWEBVIEW2_MOUSE_EVENT_KIND_RIGHT_BUTTON_DOWN, COREWEBVIEW2_MOUSE_EVENT_KIND_RIGHT_BUTTON_UP,
    COREWEBVIEW2_MOUSE_EVENT_KIND_WHEEL, COREWEBVIEW2_MOUSE_EVENT_KIND_X_BUTTON_DOWN,
    COREWEBVIEW2_MOUSE_EVENT_KIND_X_BUTTON_UP, COREWEBVIEW2_MOUSE_EVENT_VIRTUAL_KEYS,
    COREWEBVIEW2_MOUSE_EVENT_VIRTUAL_KEYS_CONTROL,
    COREWEBVIEW2_MOUSE_EVENT_VIRTUAL_KEYS_LEFT_BUTTON,
    COREWEBVIEW2_MOUSE_EVENT_VIRTUAL_KEYS_MIDDLE_BUTTON,
    COREWEBVIEW2_MOUSE_EVENT_VIRTUAL_KEYS_RIGHT_BUTTON,
    COREWEBVIEW2_MOUSE_EVENT_VIRTUAL_KEYS_SHIFT,
    COREWEBVIEW2_MOUSE_EVENT_VIRTUAL_KEYS_X_BUTTON_ONE,
    COREWEBVIEW2_MOUSE_EVENT_VIRTUAL_KEYS_X_BUTTON_TWO, COREWEBVIEW2_PERMISSION_KIND_CAMERA,
    COREWEBVIEW2_PERMISSION_KIND_GEOLOCATION, COREWEBVIEW2_PERMISSION_KIND_MICROPHONE,
    COREWEBVIEW2_PERMISSION_STATE_ALLOW, COREWEBVIEW2_PERMISSION_STATE_DENY,
};
use webview2_com::{
    wait_with_pump, CreateCoreWebView2CompositionControllerCompletedHandler,
    CreateCoreWebView2EnvironmentCompletedHandler, DownloadStartingEventHandler,
    NavigationStartingEventHandler, NewWindowRequestedEventHandler,
    PermissionRequestedEventHandler,
};
use windows::{
    core::{Interface, HSTRING, PCWSTR, PWSTR},
    Win32::{
        Foundation::{HWND, POINT, RECT},
        Graphics::DirectComposition::{IDCompositionRectangleClip, IDCompositionVisual},
        System::Com::{CoInitializeEx, CoUninitialize, COINIT_APARTMENTTHREADED},
        UI::WindowsAndMessaging::{
            DispatchMessageW, PeekMessageW, TranslateMessage, MSG, PM_REMOVE, WM_QUIT,
        },
    },
};

/// How often the worker thread reconciles each web view's bounds with its
/// surface visual's clip rectangle.
const POLL: Duration = Duration::from_millis(250);

/// A task run on the WebView2 thread.
type Task = Box<dyn FnOnce() + Send>;

/// A web view living on the WebView2 thread, keyed by its id.
struct View {
    controller: ICoreWebView2CompositionController,
    /// The same controller as the plain `ICoreWebView2Controller`, for
    /// `Bounds`/`IsVisible`/`Close`.
    plain: ICoreWebView2Controller,
    webview: ICoreWebView2,
    /// The composition surface's visual the web view tree hangs from; its clip
    /// is the bounds source of truth.
    visual: IDCompositionVisual,
    width: i32,
    height: i32,
}

thread_local! {
    static VIEWS: RefCell<HashMap<u64, View>> = RefCell::new(HashMap::new());
}

/// The embedded web view. Clones share the worker's task queue, so the
/// element's event handlers can post `SendMouseInput` calls.
#[derive(Clone)]
pub struct WindowsWebView {
    id: u64,
    tasks: Sender<Task>,
    gone: Arc<AtomicBool>,
}

impl WindowsWebView {
    /// Mounts a WebView2 composition controller on `parent`'s surface visual.
    /// `window` supplies the top-level HWND WebView2 uses for focus and
    /// keyboard routing.
    pub fn create(parent: &NativeViewParent<'_>, window: &mut Window, url: &str) -> Result<Self> {
        let unknown = parent
            .visual()?
            .downcast::<windows::core::IUnknown>()
            .map_err(|_| Error::msg("composition surface is not a DirectComposition visual"))?;
        let visual: IDCompositionVisual = unknown
            .cast()
            .map_err(|e| Error::msg(format!("composition visual cast: {e}")))?;
        let hwnd = match HasWindowHandle::window_handle(window)
            .map_err(|e| Error::msg(format!("window handle: {e}")))?
            .as_raw()
        {
            RawWindowHandle::Win32(handle) => HWND(handle.hwnd.get() as _),
            _ => return Err(Error::msg("window handle is not a Win32 HWND")),
        };

        let id = next_id();
        let tasks = ensure_worker()?;
        let (tx, rx) = mpsc::channel();
        let url = url.to_string();
        post(&tasks, move || {
            let _ = tx.send(build_view(id, hwnd, visual, &url));
        })?;
        rx.recv()
            .unwrap_or_else(|_| Err(Error::msg("WebView2 thread stopped during web view setup")))?;

        Ok(Self {
            id,
            tasks,
            gone: Arc::new(AtomicBool::new(false)),
        })
    }

    /// `composited`: the content lives on the surface's visual, which the
    /// compositor places, clips and hides — core has nothing to move.
    pub fn handle(&self) -> NativeViewHandle {
        NativeViewHandle::composited()
    }

    /// Loads a different URL in the running web view.
    pub fn set_url(&self, url: &str) {
        if self.gone.load(Ordering::SeqCst) {
            return;
        }
        let id = self.id;
        let url = url.to_string();
        let _ = post(&self.tasks, move || {
            VIEWS.with(|views| {
                if let Some(view) = views.borrow().get(&id) {
                    unsafe {
                        let _ = view.webview.Navigate(&HSTRING::from(url));
                    }
                }
            });
        });
    }

    /// Forwards one mouse/scroll event to the web view.
    fn send_mouse(
        &self,
        kind: COREWEBVIEW2_MOUSE_EVENT_KIND,
        keys: COREWEBVIEW2_MOUSE_EVENT_VIRTUAL_KEYS,
        data: u32,
        point: POINT,
    ) {
        if self.gone.load(Ordering::SeqCst) {
            return;
        }
        let id = self.id;
        let _ = post(&self.tasks, move || {
            VIEWS.with(|views| {
                if let Some(view) = views.borrow().get(&id) {
                    unsafe {
                        let _ = view.controller.SendMouseInput(kind, keys, data, point);
                    }
                }
            });
        });
    }

    /// The element that paints the node's GPUI content and forwards its mouse
    /// and scroll events to the web view. Events carry positions in window
    /// pixels; the canvas child records the element's origin each frame so
    /// they can be translated into the web view's coordinate space (device
    /// pixels relative to the surface).
    pub fn element(&self) -> AnyElement {
        let origin = Arc::new(Mutex::new((0.0f32, 0.0f32)));
        let origin_reader = origin.clone();
        let to_point = move |position: gpui::Point<gpui::Pixels>, window: &Window| {
            let (ox, oy) = *origin_reader.lock().unwrap();
            let scale = window.scale_factor();
            POINT {
                x: ((f32::from(position.x) - ox) * scale) as i32,
                y: ((f32::from(position.y) - oy) * scale) as i32,
            }
        };
        let to_point = std::rc::Rc::new(to_point);

        let mut element = div().size_full();
        for (button, down, up) in [
            (
                MouseButton::Left,
                COREWEBVIEW2_MOUSE_EVENT_KIND_LEFT_BUTTON_DOWN,
                COREWEBVIEW2_MOUSE_EVENT_KIND_LEFT_BUTTON_UP,
            ),
            (
                MouseButton::Right,
                COREWEBVIEW2_MOUSE_EVENT_KIND_RIGHT_BUTTON_DOWN,
                COREWEBVIEW2_MOUSE_EVENT_KIND_RIGHT_BUTTON_UP,
            ),
            (
                MouseButton::Middle,
                COREWEBVIEW2_MOUSE_EVENT_KIND_MIDDLE_BUTTON_DOWN,
                COREWEBVIEW2_MOUSE_EVENT_KIND_MIDDLE_BUTTON_UP,
            ),
            (
                MouseButton::Navigate(NavigationDirection::Back),
                COREWEBVIEW2_MOUSE_EVENT_KIND_X_BUTTON_DOWN,
                COREWEBVIEW2_MOUSE_EVENT_KIND_X_BUTTON_UP,
            ),
            (
                MouseButton::Navigate(NavigationDirection::Forward),
                COREWEBVIEW2_MOUSE_EVENT_KIND_X_BUTTON_DOWN,
                COREWEBVIEW2_MOUSE_EVENT_KIND_X_BUTTON_UP,
            ),
        ] {
            let view = self.clone();
            let to_point = to_point.clone();
            element = element.on_mouse_down(button, move |event, window, _cx| {
                view.send_mouse(
                    down,
                    virtual_keys(event, Some(button)),
                    0,
                    to_point(event.position, window),
                );
            });
            let view = self.clone();
            let to_point = to_point.clone();
            element = element.on_mouse_up(button, move |event, window, _cx| {
                view.send_mouse(
                    up,
                    virtual_keys(event, None),
                    0,
                    to_point(event.position, window),
                );
            });
        }

        {
            let view = self.clone();
            let to_point = to_point.clone();
            element = element.on_mouse_move(move |event, window, _cx| {
                view.send_mouse(
                    COREWEBVIEW2_MOUSE_EVENT_KIND_MOVE,
                    virtual_keys(event, event.pressed_button),
                    0,
                    to_point(event.position, window),
                );
            });
        }
        {
            let view = self.clone();
            let to_point = to_point.clone();
            element = element.on_mouse_exit(move |event, window, _cx| {
                view.send_mouse(
                    COREWEBVIEW2_MOUSE_EVENT_KIND_LEAVE,
                    virtual_keys(event, event.pressed_button),
                    0,
                    to_point(event.position, window),
                );
            });
        }
        {
            let view = self.clone();
            let to_point = to_point.clone();
            element = element.on_scroll_wheel(move |event, window, _cx| {
                // The wheel delta rides in the data's high word, like
                // WM_MOUSEWHEEL's wParam: one line is 120 raw units, a pixel
                // scroll maps ~4:1 onto it.
                let (delta_x, delta_y) = match event.delta {
                    gpui::ScrollDelta::Lines(lines) => (-lines.x * 120.0, -lines.y * 120.0),
                    gpui::ScrollDelta::Pixels(pixels) => {
                        (-f32::from(pixels.x) * 4.0, -f32::from(pixels.y) * 4.0)
                    }
                };
                let (kind, data) = if delta_y.abs() >= delta_x.abs() {
                    (
                        COREWEBVIEW2_MOUSE_EVENT_KIND_WHEEL,
                        (delta_y as i32 as u32) << 16,
                    )
                } else {
                    (
                        COREWEBVIEW2_MOUSE_EVENT_KIND_HORIZONTAL_WHEEL,
                        (delta_x as i32 as u32) << 16,
                    )
                };
                view.send_mouse(
                    kind,
                    virtual_keys(event, None),
                    data,
                    to_point(event.position, window),
                );
            });
        }

        element
            .child(
                canvas(
                    move |bounds, _window, _cx| {
                        *origin.lock().unwrap() =
                            (f32::from(bounds.origin.x), f32::from(bounds.origin.y));
                    },
                    |_, _, _, _| {},
                )
                .size_full(),
            )
            .into_any_element()
    }
}

/// Modifier keys plus the button state WebView2 expects alongside each mouse
/// event. `pressed` is the button gpui's move/exit events report as down.
fn virtual_keys<E: EventModifiers>(
    event: &E,
    pressed: Option<MouseButton>,
) -> COREWEBVIEW2_MOUSE_EVENT_VIRTUAL_KEYS {
    let mut keys = COREWEBVIEW2_MOUSE_EVENT_VIRTUAL_KEYS::default();
    let modifiers = event.event_modifiers();
    if modifiers.shift {
        keys |= COREWEBVIEW2_MOUSE_EVENT_VIRTUAL_KEYS_SHIFT;
    }
    if modifiers.control {
        keys |= COREWEBVIEW2_MOUSE_EVENT_VIRTUAL_KEYS_CONTROL;
    }
    if let Some(button) = pressed {
        keys |= match button {
            MouseButton::Left => COREWEBVIEW2_MOUSE_EVENT_VIRTUAL_KEYS_LEFT_BUTTON,
            MouseButton::Right => COREWEBVIEW2_MOUSE_EVENT_VIRTUAL_KEYS_RIGHT_BUTTON,
            MouseButton::Middle => COREWEBVIEW2_MOUSE_EVENT_VIRTUAL_KEYS_MIDDLE_BUTTON,
            MouseButton::Navigate(NavigationDirection::Back) => {
                COREWEBVIEW2_MOUSE_EVENT_VIRTUAL_KEYS_X_BUTTON_ONE
            }
            MouseButton::Navigate(NavigationDirection::Forward) => {
                COREWEBVIEW2_MOUSE_EVENT_VIRTUAL_KEYS_X_BUTTON_TWO
            }
            _ => COREWEBVIEW2_MOUSE_EVENT_VIRTUAL_KEYS::default(),
        };
    }
    keys
}

/// The bits of a gpui mouse event `virtual_keys` needs, so one helper covers
/// down/up/move/exit/scroll events.
trait EventModifiers {
    fn event_modifiers(&self) -> gpui::Modifiers;
}

macro_rules! impl_event_modifiers {
    ($($ty:ty),+) => {
        $(
            impl EventModifiers for $ty {
                fn event_modifiers(&self) -> gpui::Modifiers {
                    self.modifiers
                }
            }
        )+
    };
}

impl_event_modifiers!(
    gpui::MouseDownEvent,
    gpui::MouseUpEvent,
    gpui::MouseMoveEvent,
    gpui::MouseExitEvent,
    gpui::ScrollEvent
);

/// Posts a task to the WebView2 thread.
fn post(tasks: &Sender<Task>, task: impl FnOnce() + Send + 'static) -> Result<()> {
    tasks
        .send(Box::new(task))
        .map_err(|_| Error::msg("WebView2 thread stopped"))
}

static NEXT_ID: AtomicU64 = AtomicU64::new(1);

fn next_id() -> u64 {
    NEXT_ID.fetch_add(1, Ordering::SeqCst)
}

/// Starts the dedicated WebView2 STA thread once and returns a clone of its
/// task queue's sender.
fn ensure_worker() -> Result<Sender<Task>> {
    static STARTED: Once = Once::new();
    static WORKER: Mutex<Option<Sender<Task>>> = Mutex::new(None);
    STARTED.call_once(|| {
        let (tx, rx) = mpsc::channel::<Task>();
        if thread::Builder::new()
            .name("synara-webview-wv2".into())
            .spawn(move || worker_main(rx))
            .is_ok()
        {
            *WORKER.lock().unwrap() = Some(tx);
        }
    });
    WORKER
        .lock()
        .unwrap()
        .clone()
        .ok_or_else(|| Error::msg("WebView2 thread failed to start"))
}

/// The WebView2 thread: STA init, then a loop alternating between queued
/// tasks, the thread's message pump (which delivers WebView2's async
/// callbacks), and the bounds poll.
fn worker_main(rx: Receiver<Task>) {
    unsafe {
        let _ = CoInitializeEx(None, COINIT_APARTMENTTHREADED);
    }
    loop {
        match rx.recv_timeout(POLL) {
            Ok(task) => task(),
            Err(mpsc::RecvTimeoutError::Timeout) => poll_views(),
            Err(mpsc::RecvTimeoutError::Disconnected) => break,
        }
        // Drain the thread's message queue; WebView2 delivers its async
        // completion callbacks and events through it.
        let mut msg = MSG::default();
        while unsafe { PeekMessageW(&mut msg, None, 0, 0, PM_REMOVE) }.as_bool() {
            if msg.message == WM_QUIT {
                unsafe { CoUninitialize() };
                return;
            }
            unsafe {
                let _ = TranslateMessage(&msg);
                let _ = DispatchMessageW(&msg);
            }
        }
    }
    unsafe { CoUninitialize() };
}

/// Builds the WebView2 on the worker thread: environment, composition
/// controller rooted at the surface visual, hardening, first navigation.
/// `wait_with_pump` is safe here because this already runs on the pumping
/// worker thread.
fn build_view(id: u64, hwnd: HWND, visual: IDCompositionVisual, url: &str) -> Result<()> {
    let environment = create_environment()?;
    let controller = create_composition_controller(&environment, hwnd)?;
    unsafe {
        let target: windows::core::IUnknown = visual
            .cast()
            .map_err(|e| Error::msg(format!("visual cast to IUnknown: {e}")))?;
        controller
            .SetRootVisualTarget(&target)
            .map_err(|e| Error::msg(format!("RootVisualTarget: {e}")))?;
    }
    let plain: ICoreWebView2Controller = controller
        .cast()
        .map_err(|e| Error::msg(format!("controller cast: {e}")))?;
    if let Ok(cc3) = controller.cast::<ICoreWebView2CompositionController3>() {
        // The visual tree is in device pixels; raw pixels keeps bounds in the
        // same space instead of logical (DIP) coordinates.
        unsafe {
            let _ = cc3.SetBoundsMode(COREWEBVIEW2_BOUNDS_MODE_USE_RAW_PIXELS);
        }
    }
    let webview = unsafe {
        plain
            .CoreWebView2()
            .map_err(|e| Error::msg(format!("CoreWebView2: {e}")))?
    };
    harden(&webview)?;
    unsafe {
        plain
            .SetIsVisible(true)
            .map_err(|e| Error::msg(format!("IsVisible: {e}")))?;
        plain
            .SetBounds(RECT {
                left: 0,
                top: 0,
                right: 1,
                bottom: 1,
            })
            .map_err(|e| Error::msg(format!("Bounds: {e}")))?;
        webview
            .Navigate(&HSTRING::from(url))
            .map_err(|e| Error::msg(format!("Navigate: {e}")))?;
    }
    VIEWS.with(|views| {
        views.borrow_mut().insert(
            id,
            View {
                controller,
                plain,
                webview,
                visual,
                width: 1,
                height: 1,
            },
        );
    });
    Ok(())
}

/// Creates the WebView2 environment, pumping this thread until the completion
/// callback arrives.
fn create_environment() -> Result<ICoreWebView2Environment> {
    let (tx, rx) = mpsc::channel();
    let user_data = user_data_dir();
    unsafe {
        CreateCoreWebView2EnvironmentWithOptions(
            PCWSTR::null(),
            &HSTRING::from(user_data.to_string_lossy().as_ref()),
            &ICoreWebView2EnvironmentOptions::from(CoreWebView2EnvironmentOptions::default()),
            &CreateCoreWebView2EnvironmentCompletedHandler::create(Box::new(
                move |error_code, environment| {
                    let result = (|| {
                        error_code?;
                        environment.ok_or_else(|| {
                            windows::core::Error::from(windows::Win32::Foundation::E_POINTER)
                        })
                    })();
                    tx.send(result).map_err(|_| {
                        windows::core::Error::from(windows::Win32::Foundation::E_UNEXPECTED)
                    })
                },
            )),
        )
        .map_err(|e| Error::msg(format!("CreateCoreWebView2EnvironmentWithOptions: {e}")))?;
    }
    wait_with_pump(rx).map_err(|e| Error::msg(format!("webview2 environment: {e}")))
}

/// Creates the composition controller bound to `hwnd` (the window WebView2
/// uses for focus and keyboard routing), pumping until ready.
fn create_composition_controller(
    environment: &ICoreWebView2Environment,
    hwnd: HWND,
) -> Result<ICoreWebView2CompositionController> {
    let (tx, rx) = mpsc::channel();
    unsafe {
        environment
            .CreateCoreWebView2CompositionController(
                hwnd,
                &CreateCoreWebView2CompositionControllerCompletedHandler::create(Box::new(
                    move |error_code, controller| {
                        let result = (|| {
                            error_code?;
                            controller.ok_or_else(|| {
                                windows::core::Error::from(windows::Win32::Foundation::E_POINTER)
                            })
                        })();
                        tx.send(result).map_err(|_| {
                            windows::core::Error::from(windows::Win32::Foundation::E_UNEXPECTED)
                        })
                    },
                )),
            )
            .map_err(|e| Error::msg(format!("CreateCoreWebView2CompositionController: {e}")))?;
    }
    wait_with_pump(rx).map_err(|e| Error::msg(format!("webview2 composition controller: {e}")))
}

/// Applies the same hardening policy as the Linux backend.
fn harden(webview: &ICoreWebView2) -> Result<()> {
    let settings = unsafe {
        webview
            .Settings()
            .map_err(|e| Error::msg(format!("Settings: {e}")))?
    };
    unsafe {
        settings
            .SetAreDevToolsEnabled(false)
            .map_err(|e| Error::msg(format!("AreDevToolsEnabled: {e}")))?;
        settings
            .SetAreHostObjectsAllowed(false)
            .map_err(|e| Error::msg(format!("AreHostObjectsAllowed: {e}")))?;
        settings
            .SetAreDefaultScriptDialogsEnabled(false)
            .map_err(|e| Error::msg(format!("AreDefaultScriptDialogsEnabled: {e}")))?;
        settings
            .SetIsStatusBarEnabled(false)
            .map_err(|e| Error::msg(format!("IsStatusBarEnabled: {e}")))?;
        if let Ok(settings3) = settings.cast::<ICoreWebView2Settings3>() {
            let _ = settings3.SetAreBrowserAcceleratorKeysEnabled(false);
        }
    }

    let mut token = 0i64;
    unsafe {
        webview
            .add_NavigationStarting(
                &NavigationStartingEventHandler::create(Box::new(|_, args| {
                    let Some(args) = args else {
                        return Ok(());
                    };
                    let mut uri = PWSTR::null();
                    args.Uri(&mut uri)?;
                    let uri = take_pwstr(uri);
                    let allowed = uri.starts_with("http://")
                        || uri.starts_with("https://")
                        || uri.starts_with("about:");
                    args.SetCancel(!allowed)
                })),
                &mut token,
            )
            .map_err(|e| Error::msg(format!("NavigationStarting: {e}")))?;
        webview
            .add_NewWindowRequested(
                &NewWindowRequestedEventHandler::create(Box::new(|_, args| {
                    let Some(args) = args else {
                        return Ok(());
                    };
                    args.SetHandled(true)
                })),
                &mut token,
            )
            .map_err(|e| Error::msg(format!("NewWindowRequested: {e}")))?;
        webview
            .add_PermissionRequested(
                &PermissionRequestedEventHandler::create(Box::new(|_, args| {
                    let Some(args) = args else {
                        return Ok(());
                    };
                    let mut kind = Default::default();
                    args.PermissionKind(&mut kind)?;
                    let state = match kind {
                        COREWEBVIEW2_PERMISSION_KIND_MICROPHONE
                        | COREWEBVIEW2_PERMISSION_KIND_CAMERA
                        | COREWEBVIEW2_PERMISSION_KIND_GEOLOCATION => {
                            COREWEBVIEW2_PERMISSION_STATE_DENY
                        }
                        _ => COREWEBVIEW2_PERMISSION_STATE_ALLOW,
                    };
                    args.SetState(state)
                })),
                &mut token,
            )
            .map_err(|e| Error::msg(format!("PermissionRequested: {e}")))?;
        if let Ok(webview4) = webview.cast::<ICoreWebView2_4>() {
            let _ = webview4.add_DownloadStarting(
                &DownloadStartingEventHandler::create(Box::new(|_, args| {
                    let Some(args) = args else {
                        return Ok(());
                    };
                    args.SetHandled(true)?;
                    args.DownloadOperation()?.Cancel()
                })),
                &mut token,
            );
        }
    }
    Ok(())
}

/// Reads a `PWSTR` WebView2 hands back into an owned `String`, like wry's
/// `take_pwstr`.
fn take_pwstr(uri: PWSTR) -> String {
    if uri.is_null() {
        return String::new();
    }
    unsafe { uri.to_string().unwrap_or_default() }
}

/// The WebView2 user-data folder: isolated like the Linux backend's profile,
/// but stable across launches so sessions keep their storage.
fn user_data_dir() -> std::path::PathBuf {
    let dir = std::env::var_os("SYNARA_WEBVIEW2_USER_DATA")
        .map(std::path::PathBuf::from)
        .unwrap_or_else(|| std::env::temp_dir().join("synara-gpui-webview2"));
    let _ = std::fs::create_dir_all(&dir);
    dir
}

/// Worker-thread poll: keeps each web view's `Bounds`/`IsVisible` in sync with
/// its surface visual's clip (the compositor sets the clip to the node's
/// device-pixel bounds and zeroes it when the node is hidden), and drops
/// views whose visual the compositor tore down.
fn poll_views() {
    VIEWS.with(|views| {
        views.borrow_mut().retain(|_, view| {
            let clip = unsafe {
                view.visual
                    .GetClip()
                    .ok()
                    .and_then(|clip| clip.cast::<IDCompositionRectangleClip>().ok())
            };
            let Some(clip) = clip else {
                // The surface was torn down: close the web view with it.
                unsafe {
                    let _ = view.plain.Close();
                }
                return false;
            };
            let (width, height) = unsafe {
                (
                    clip.GetRight().unwrap_or(0.0),
                    clip.GetBottom().unwrap_or(0.0),
                )
            };
            let (width, height) = (width as i32, height as i32);
            if (width, height) != (view.width, view.height) {
                view.width = width;
                view.height = height;
                unsafe {
                    let _ = view.plain.SetBounds(RECT {
                        left: 0,
                        top: 0,
                        right: width.max(1),
                        bottom: height.max(1),
                    });
                    let _ = view.plain.SetIsVisible(width > 0 && height > 0);
                }
            }
            true
        });
    });
}

impl Drop for WindowsWebView {
    fn drop(&mut self) {
        self.gone.store(true, Ordering::SeqCst);
        let id = self.id;
        let (tx, rx) = mpsc::channel();
        let _ = post(&self.tasks, move || {
            VIEWS.with(|views| {
                if let Some(view) = views.borrow_mut().remove(&id) {
                    unsafe {
                        let _ = view.plain.Close();
                    }
                }
            });
            let _ = tx.send(());
        });
        // Let the WebView2 thread close the controller before the caller moves
        // on; bounded so a dead thread cannot hang unmount.
        let _ = rx.recv_timeout(Duration::from_millis(500));
    }
}
