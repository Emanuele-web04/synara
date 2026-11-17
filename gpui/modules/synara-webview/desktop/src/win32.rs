//! The Windows web view: an in-process WebView2 composition controller whose
//! root visual is the composition surface's own `IDCompositionVisual`.
//!
//! Scope: the frame is interactive (composition input, navigation hardening,
//! resize) but, unlike the macOS `appkit` backend, installs no `desktopBridge`
//! — AppSnap, updater and native IPC surfaces are macOS-only for now.
//!
//! The compositor places, clips and hides the surface's visual, so the native
//! view reports `composited` and the WebView's visual tree rides along with no
//! child window to track — `composited` is what this platform asks native
//! components to return.
//!
//! Every WebView2 call happens on GPUI's UI thread. The composition
//! controller and its parent HWND must belong to the same thread: created
//! on a different thread, the browser process starts up and then shuts down
//! cleanly a second later. GPUI already pumps this thread's message queue,
//! which is what delivers WebView2's async completion callbacks and events.
//! The element's prepaint reports the node's bounds each frame — the
//! compositor positions the visual, but WebView2 still needs `put_Bounds`
//! to size its content — and `put_Bounds`/`put_IsVisible` are applied when
//! they change. (DirectComposition exposes no `GetClip`, so bounds come
//! from GPUI, not from the visual.)
//!
//! Input: the compositor's hit test gives native surfaces their window region
//! before GPUI elements see it, so element-level listeners never fire here.
//! The view instead registers a consumer on its composition surface
//! (`WindowComposition::on_input`), which receives mouse/scroll events in
//! window pixels and forwards them through `SendMouseInput`. Keyboard input
//! needs no forwarding: a `MoveFocus` on the first press hands OS focus to
//! WebView2, which routes keys natively from then on.
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
        mpsc::Receiver,
        Arc, Mutex,
    },
    thread,
    time::{Duration, Instant},
};

use gpui::{
    canvas, div, prelude::*, AnyElement, CompositionSurfaceKind, DispatchEventResult, MouseButton,
    NavigationDirection, PlatformInput, Window,
};
use raw_window_handle::{HasWindowHandle, RawWindowHandle};
use react_native_gpui::native_surface::{Error, NativeViewHandle, NativeViewParent, Result};
use webview2_com::Microsoft::Web::WebView2::Win32::{
    CreateCoreWebView2EnvironmentWithOptions, ICoreWebView2, ICoreWebView2CompositionController,
    ICoreWebView2Controller, ICoreWebView2Controller3, ICoreWebView2Environment,
    ICoreWebView2Environment3, ICoreWebView2EnvironmentOptions, ICoreWebView2Settings3,
    ICoreWebView2_4, COREWEBVIEW2_BOUNDS_MODE_USE_RAW_PIXELS, COREWEBVIEW2_MOUSE_EVENT_KIND,
    COREWEBVIEW2_MOUSE_EVENT_KIND_HORIZONTAL_WHEEL, COREWEBVIEW2_MOUSE_EVENT_KIND_LEAVE,
    COREWEBVIEW2_MOUSE_EVENT_KIND_LEFT_BUTTON_DOWN, COREWEBVIEW2_MOUSE_EVENT_KIND_LEFT_BUTTON_UP,
    COREWEBVIEW2_MOUSE_EVENT_KIND_MIDDLE_BUTTON_DOWN,
    COREWEBVIEW2_MOUSE_EVENT_KIND_MIDDLE_BUTTON_UP, COREWEBVIEW2_MOUSE_EVENT_KIND_MOVE,
    COREWEBVIEW2_MOUSE_EVENT_KIND_RIGHT_BUTTON_DOWN, COREWEBVIEW2_MOUSE_EVENT_KIND_RIGHT_BUTTON_UP,
    COREWEBVIEW2_MOUSE_EVENT_KIND_WHEEL, COREWEBVIEW2_MOUSE_EVENT_KIND_X_BUTTON_DOWN,
    COREWEBVIEW2_MOUSE_EVENT_KIND_X_BUTTON_UP, COREWEBVIEW2_MOUSE_EVENT_VIRTUAL_KEYS,
    COREWEBVIEW2_MOUSE_EVENT_VIRTUAL_KEYS_CONTROL,
    COREWEBVIEW2_MOUSE_EVENT_VIRTUAL_KEYS_LEFT_BUTTON,
    COREWEBVIEW2_MOUSE_EVENT_VIRTUAL_KEYS_MIDDLE_BUTTON,
    COREWEBVIEW2_MOUSE_EVENT_VIRTUAL_KEYS_RIGHT_BUTTON,
    COREWEBVIEW2_MOUSE_EVENT_VIRTUAL_KEYS_SHIFT, COREWEBVIEW2_MOUSE_EVENT_VIRTUAL_KEYS_X_BUTTON1,
    COREWEBVIEW2_MOUSE_EVENT_VIRTUAL_KEYS_X_BUTTON2, COREWEBVIEW2_MOVE_FOCUS_REASON_PROGRAMMATIC,
    COREWEBVIEW2_PERMISSION_KIND_CAMERA, COREWEBVIEW2_PERMISSION_KIND_CLIPBOARD_READ,
    COREWEBVIEW2_PERMISSION_KIND_FILE_READ_WRITE, COREWEBVIEW2_PERMISSION_KIND_GEOLOCATION,
    COREWEBVIEW2_PERMISSION_KIND_LOCAL_FONTS, COREWEBVIEW2_PERMISSION_KIND_MICROPHONE,
    COREWEBVIEW2_PERMISSION_KIND_MIDI_SYSTEM_EXCLUSIVE_MESSAGES,
    COREWEBVIEW2_PERMISSION_KIND_MULTIPLE_AUTOMATIC_DOWNLOADS,
    COREWEBVIEW2_PERMISSION_KIND_OTHER_SENSORS, COREWEBVIEW2_PERMISSION_KIND_WINDOW_MANAGEMENT,
    COREWEBVIEW2_PERMISSION_STATE_ALLOW, COREWEBVIEW2_PERMISSION_STATE_DENY,
};
use webview2_com::{
    CoreWebView2EnvironmentOptions, CreateCoreWebView2CompositionControllerCompletedHandler,
    CreateCoreWebView2EnvironmentCompletedHandler, DownloadStartingEventHandler,
    NavigationStartingEventHandler, NewWindowRequestedEventHandler,
    PermissionRequestedEventHandler,
};
use windows::{
    core::{Interface, BOOL, HSTRING, PCWSTR, PWSTR},
    Win32::{
        Foundation::{HWND, LPARAM, LRESULT, POINT, RECT, WPARAM},
        Graphics::DirectComposition::IDCompositionVisual,
        System::Com::{CoInitializeEx, COINIT_APARTMENTTHREADED},
        System::Threading::GetCurrentThreadId,
        UI::WindowsAndMessaging::{
            DefWindowProcW, DispatchMessageW, EnumThreadWindows, GetClassNameW, GetWindowLongPtrW,
            GetWindowThreadProcessId, PeekMessageW, PostMessageW, PostThreadMessageW,
            SetWindowLongPtrW, TranslateMessage, GWLP_WNDPROC, MSG, PM_REMOVE,
        },
    },
};

/// How long `wait_for` pumps the UI thread's queue for a WebView2 async
/// call before giving up.
const WAIT_TIMEOUT: Duration = Duration::from_secs(30);

/// A web view living on the UI thread, keyed by its id.
struct View {
    controller: ICoreWebView2CompositionController,
    /// The same controller as the plain `ICoreWebView2Controller`, for
    /// `Bounds`/`IsVisible`/`Close`.
    plain: ICoreWebView2Controller,
    webview: ICoreWebView2,
    /// Kept alive for the controller's lifetime: releasing the last
    /// environment reference shuts the browser process down.
    _environment: ICoreWebView2Environment,
    /// The window's HWND: closing the controller pumps sent messages to it,
    /// so the wndproc needs the same shield used during setup.
    hwnd: HWND,
    /// Last bounds the element reported, in device pixels.
    width: i32,
    height: i32,
}

thread_local! {
    static VIEWS: RefCell<HashMap<u64, View>> = RefCell::new(HashMap::new());
}

/// The shareable half of a web view: cloned into the element's event
/// handlers so they can reach the view. Dropping a clone does nothing —
/// only the owning `WindowsWebView` closes the controller.
#[derive(Clone)]
struct ViewHandle {
    id: u64,
    gone: Arc<AtomicBool>,
    /// Width<<32 | height last applied, so the per-frame prepaint skips
    /// `put_Bounds` when nothing changed.
    posted_bounds: Arc<AtomicU64>,
    /// The element's origin in window logical pixels plus the window scale,
    /// written each frame by the canvas prepaint so incoming platform input
    /// can be translated into the web view's device-pixel space. The scale
    /// rides along because GPUI can change it when the window crosses
    /// monitors with different display scaling.
    origin: Arc<Mutex<(f32, f32, f32)>>,
}

/// The embedded web view. Everything lives on the UI thread; `element`
/// clones its `ViewHandle` for event handlers while this stays the single
/// owner — the element is rebuilt every frame, so a `Drop` on the shared
/// handle would close the view on the first repaint.
pub struct WindowsWebView {
    shared: ViewHandle,
}

impl WindowsWebView {
    /// Mounts a WebView2 composition controller on `parent`'s surface visual.
    /// `window` supplies the top-level HWND WebView2 uses for focus and
    /// keyboard routing. Runs on the UI thread, which must be an STA thread
    /// that owns `window`'s HWND.
    pub fn create(parent: &NativeViewParent<'_>, window: &mut Window, url: &str) -> Result<Self> {
        unsafe {
            CoInitializeEx(None, COINIT_APARTMENTTHREADED)
                .ok()
                .map_err(|e| Error::msg(format!("CoInitializeEx (UI thread must be STA): {e}")))?;
        }
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
        // synchronous `SendMessage`s during setup) runs the window's
        // wndproc, which borrows `App` — and `App` is already borrowed by
        // the mount we're inside of. Swap in a `DefWindowProc` shield until
        // the WebView2 exists so those messages can't reenter GPUI.
        let _shield = WndProcShield::install(hwnd);
        build_view(id, hwnd, visual, url)?;

        let shared = ViewHandle {
            id,
            gone: Arc::new(AtomicBool::new(false)),
            posted_bounds: Arc::new(AtomicU64::new(0)),
            origin: Arc::new(Mutex::new((0.0, 0.0, 1.0))),
        };
        Self::attach_input(window, &shared)?;
        Ok(Self { shared })
    }

    /// Registers the view as its composition surface's input consumer. The
    /// compositor's hit test hands the region over a native surface to that
    /// surface before any GPUI element, so element-level listeners would
    /// never fire; `on_input` is the framework's channel to windowless
    /// producers. The surface the node created for this view is the newest
    /// native surface in the tree.
    fn attach_input(window: &Window, shared: &ViewHandle) -> Result<()> {
        let composition = window
            .enable_window_composition()
            .map_err(|e| Error::msg(format!("window composition: {e:#}")))?;
        let surface = composition
            .children(None)
            .ok()
            .and_then(|ids| {
                ids.into_iter().rev().find(|id| {
                    composition
                        .surface_kind(*id)
                        .is_ok_and(|kind| kind == CompositionSurfaceKind::Native)
                })
            })
            .ok_or_else(|| Error::msg("native composition surface not found"))?;
        let handle = shared.clone();
        composition
            .on_input(surface, move |input| handle.platform_input(input))
            .map_err(|e| Error::msg(format!("composition on_input: {e:#}")))
    }

    /// `composited`: the content lives on the surface's visual, which the
    /// compositor places, clips and hides — core has nothing to move.
    pub fn handle(&self) -> NativeViewHandle {
        NativeViewHandle::composited()
    }

    /// Loads a different URL in the running web view.
    pub fn set_url(&self, url: &str) {
        self.shared.set_url(url);
    }

    /// The element that paints the node's GPUI content and records the
    /// view's bounds and origin each frame.
    pub fn element(&self) -> AnyElement {
        self.shared.element()
    }
}

impl ViewHandle {
    /// Loads a different URL in the running web view.
    fn set_url(&self, url: &str) {
        if self.gone.load(Ordering::SeqCst) {
            return;
        }
        VIEWS.with(|views| {
            if let Some(view) = views.borrow().get(&self.id) {
                unsafe {
                    let _ = view.webview.Navigate(&HSTRING::from(url));
                }
            }
        });
    }

    /// Pushes a bounds update: `put_Bounds`/`put_IsVisible` are applied only
    /// when the device-pixel size actually changes. Called from the
    /// element's prepaint, so it runs once per frame.
    fn report_bounds(&self, width: i32, height: i32) {
        if self.gone.load(Ordering::SeqCst) {
            return;
        }
        let packed = ((width.max(0) as u64) << 32) | (height.max(0) as u64);
        if self.posted_bounds.swap(packed, Ordering::SeqCst) == packed {
            return;
        }
        VIEWS.with(|views| {
            if let Some(view) = views.borrow_mut().get_mut(&self.id) {
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
            }
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
        VIEWS.with(|views| {
            if let Some(view) = views.borrow().get(&self.id) {
                unsafe {
                    let _ = view.controller.SendMouseInput(kind, keys, data, point);
                }
            }
        });
    }

    /// Hands OS keyboard focus to WebView2: a press means the user is typing
    /// into the page, and once focused the browser's own HWND takes keyboard
    /// input natively.
    fn move_focus(&self) {
        if self.gone.load(Ordering::SeqCst) {
            return;
        }
        VIEWS.with(|views| {
            if let Some(view) = views.borrow().get(&self.id) {
                unsafe {
                    let _ = view
                        .plain
                        .MoveFocus(COREWEBVIEW2_MOVE_FOCUS_REASON_PROGRAMMATIC);
                }
            }
        });
    }

    /// A window-logical-pixel position in the web view's device-pixel space.
    /// Reads the latest origin and scale the prepaint published this frame.
    fn to_point(&self, position: gpui::Point<gpui::Pixels>) -> POINT {
        let (ox, oy, scale) = *self.origin.lock().unwrap();
        POINT {
            x: ((f32::from(position.x) - ox) * scale) as i32,
            y: ((f32::from(position.y) - oy) * scale) as i32,
        }
    }

    /// Handles one input event the compositor aimed at the view's surface.
    /// The events arrive in window logical pixels and are consumed — the
    /// compositor already kept them away from GPUI elements behind the
    /// surface, and nothing above the web view should see them either.
    fn platform_input(&self, input: &PlatformInput) -> DispatchEventResult {
        match input {
            PlatformInput::MouseDown(event) => {
                if let Some(kind) = down_kind(event.button) {
                    self.move_focus();
                    self.send_mouse(
                        kind,
                        virtual_keys(event, Some(event.button)),
                        x_button_data(event.button),
                        self.to_point(event.position),
                    );
                }
            }
            PlatformInput::MouseUp(event) => {
                if let Some(kind) = up_kind(event.button) {
                    self.send_mouse(
                        kind,
                        virtual_keys(event, None),
                        x_button_data(event.button),
                        self.to_point(event.position),
                    );
                }
            }
            PlatformInput::MouseMove(event) => self.send_mouse(
                COREWEBVIEW2_MOUSE_EVENT_KIND_MOVE,
                virtual_keys(event, event.pressed_button),
                0,
                self.to_point(event.position),
            ),
            PlatformInput::MouseExited(event) => self.send_mouse(
                COREWEBVIEW2_MOUSE_EVENT_KIND_LEAVE,
                virtual_keys(event, event.pressed_button),
                0,
                self.to_point(event.position),
            ),
            PlatformInput::Scroll(event) => {
                // The wheel delta rides in the data's high word, like
                // WM_MOUSEWHEEL's wParam — same sign gpui already carries:
                // positive means the wheel moved forward (scroll up). One
                // line is 120 raw units, a pixel scroll maps ~4:1 onto it.
                let (delta_x, delta_y) = match event.delta {
                    gpui::ScrollDelta::Lines(lines) => (lines.x * 120.0, lines.y * 120.0),
                    gpui::ScrollDelta::Pixels(pixels) => {
                        (f32::from(pixels.x) * 4.0, f32::from(pixels.y) * 4.0)
                    }
                };
                // Diagonal gestures carry both deltas: forward each nonzero
                // axis as its own wheel event rather than keeping only the
                // dominant one.
                let keys = virtual_keys(event, None);
                if delta_y != 0.0 {
                    self.send_mouse(
                        COREWEBVIEW2_MOUSE_EVENT_KIND_WHEEL,
                        keys,
                        (delta_y as i32 as u32) << 16,
                        self.to_point(event.position),
                    );
                }
                if delta_x != 0.0 {
                    self.send_mouse(
                        COREWEBVIEW2_MOUSE_EVENT_KIND_HORIZONTAL_WHEEL,
                        keys,
                        (delta_x as i32 as u32) << 16,
                        self.to_point(event.position),
                    );
                }
            }
            _ => {
                return DispatchEventResult {
                    propagate: true,
                    default_prevented: false,
                };
            }
        }
        DispatchEventResult {
            propagate: false,
            default_prevented: true,
        }
    }

    /// The element that paints the node's GPUI content and records the
    /// view's origin and bounds each frame: `origin` feeds the platform-input
    /// translation, `report_bounds` sizes the WebView's content. Input itself
    /// reaches the view through `attach_input`'s surface consumer — the
    /// compositor's hit test never offers surface events to elements. The
    /// element overlays its node absolutely so its bounds match the surface
    /// the compositor placed for the view.
    fn element(&self) -> AnyElement {
        let view = self.clone();
        div()
            .absolute()
            .inset_0()
            .child(
                canvas(
                    move |bounds, window, _cx| {
                        let scale = window.scale_factor();
                        *view.origin.lock().unwrap() = (
                            f32::from(bounds.origin.x),
                            f32::from(bounds.origin.y),
                            scale,
                        );
                        view.report_bounds(
                            (f32::from(bounds.size.width) * scale) as i32,
                            (f32::from(bounds.size.height) * scale) as i32,
                        );
                    },
                    |_, _, _, _| {},
                )
                .size_full(),
            )
            .into_any_element()
    }
}

/// The WebView2 event kind of a press, or `None` for a button WebView2 has no
/// kind for.
fn down_kind(button: MouseButton) -> Option<COREWEBVIEW2_MOUSE_EVENT_KIND> {
    Some(match button {
        MouseButton::Left => COREWEBVIEW2_MOUSE_EVENT_KIND_LEFT_BUTTON_DOWN,
        MouseButton::Right => COREWEBVIEW2_MOUSE_EVENT_KIND_RIGHT_BUTTON_DOWN,
        MouseButton::Middle => COREWEBVIEW2_MOUSE_EVENT_KIND_MIDDLE_BUTTON_DOWN,
        MouseButton::Navigate(_) => COREWEBVIEW2_MOUSE_EVENT_KIND_X_BUTTON_DOWN,
        _ => return None,
    })
}

/// The WebView2 event kind of a release, or `None` for a button WebView2 has
/// no kind for.
fn up_kind(button: MouseButton) -> Option<COREWEBVIEW2_MOUSE_EVENT_KIND> {
    Some(match button {
        MouseButton::Left => COREWEBVIEW2_MOUSE_EVENT_KIND_LEFT_BUTTON_UP,
        MouseButton::Right => COREWEBVIEW2_MOUSE_EVENT_KIND_RIGHT_BUTTON_UP,
        MouseButton::Middle => COREWEBVIEW2_MOUSE_EVENT_KIND_MIDDLE_BUTTON_UP,
        MouseButton::Navigate(_) => COREWEBVIEW2_MOUSE_EVENT_KIND_X_BUTTON_UP,
        _ => return None,
    })
}

/// Which X button an event carries, as WebView2's `mouseData` reports it.
fn x_button_data(button: MouseButton) -> u32 {
    match button {
        MouseButton::Navigate(NavigationDirection::Back) => 1,
        MouseButton::Navigate(NavigationDirection::Forward) => 2,
        _ => 0,
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
                COREWEBVIEW2_MOUSE_EVENT_VIRTUAL_KEYS_X_BUTTON1
            }
            MouseButton::Navigate(NavigationDirection::Forward) => {
                COREWEBVIEW2_MOUSE_EVENT_VIRTUAL_KEYS_X_BUTTON2
            }
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

/// Waits for a WebView2 async call started on this thread to complete,
/// pumping the message queue meanwhile: WebView2 delivers its completion
/// callbacks through the queue, and its loader sends synchronous messages
/// to the parent HWND that must be answered.
///
/// Messages addressed to `hwnd` itself are set aside and reposted at the
/// end: dispatching them here would reenter GPUI's `App` borrow, but
/// WebView2's own posted messages (and its sent messages, serviced by
/// `PeekMessage` regardless) have to flow for setup to finish.
fn wait_for<T>(rx: &Receiver<T>, _hwnd: HWND) -> Result<T> {
    let deadline = Instant::now() + WAIT_TIMEOUT;
    let mut stashed: Vec<MSG> = Vec::new();
    // GPUI can own more than one window (the platform window and internal
    // helpers share its class); their wndproc borrows `App`, which is
    // already borrowed by the mount we're inside of. Every message headed
    // for a window of that class is deferred and reposted afterwards.
    // Process at most one message per iteration: the WebView2 adapter
    // window reposts a stream of keep-alives, and draining the queue in
    // an inner loop would starve the channel and deadline checks.
    let result = loop {
        match rx.try_recv() {
            Ok(value) => break Ok(value),
            Err(mpsc::TryRecvError::Disconnected) => {
                break Err(Error::msg("WebView2 callback channel closed"))
            }
            Err(mpsc::TryRecvError::Empty) => {}
        }
        if Instant::now() > deadline {
            break Err(Error::msg("timed out waiting for WebView2"));
        }
        let mut msg = MSG::default();
        if unsafe { PeekMessageW(&mut msg, None, 0, 0, PM_REMOVE) }.as_bool() {
            let is_gpui = !msg.hwnd.0.is_null() && {
                let mut buf = [0u16; 64];
                let n = unsafe { GetClassNameW(msg.hwnd, &mut buf) } as usize;
                String::from_utf16_lossy(&buf[..n]).starts_with("GpuiFast::")
            };
            if msg.hwnd.0.is_null() || is_gpui {
                stashed.push(msg);
            } else {
                unsafe {
                    let _ = TranslateMessage(&msg);
                    let _ = DispatchMessageW(&msg);
                }
            }
        } else {
            thread::sleep(Duration::from_millis(1));
        }
    };
    // Hand the deferred messages back to the normal loop.
    for msg in stashed {
        unsafe {
            if msg.hwnd.0.is_null() {
                let _ =
                    PostThreadMessageW(GetCurrentThreadId(), msg.message, msg.wParam, msg.lParam);
            } else {
                let _ = PostMessageW(Some(msg.hwnd), msg.message, msg.wParam, msg.lParam);
            }
        }
    }
    result
}

/// Temporarily replaces the wndproc of every thread window sharing
/// `hwnd`'s class — GPUI owns several and all of them borrow `App` — with
/// `DefWindowProc`, so messages serviced while waiting on WebView2 cannot
/// reenter the `App` borrow the mount is holding. Restores each real
/// wndproc on drop. `hwnd` is only used to identify the thread to scan.
struct WndProcShield {
    swapped: Vec<(HWND, isize)>,
}

unsafe extern "system" fn shield_wndproc(
    hwnd: HWND,
    msg: u32,
    wparam: WPARAM,
    lparam: LPARAM,
) -> LRESULT {
    unsafe { DefWindowProcW(hwnd, msg, wparam, lparam) }
}

unsafe extern "system" fn enum_same_class(hwnd: HWND, lparam: LPARAM) -> BOOL {
    let (class, out) = unsafe { &mut *(lparam.0 as *mut (String, Vec<HWND>)) };
    let mut buf = [0u16; 64];
    let n = unsafe { GetClassNameW(hwnd, &mut buf) } as usize;
    if String::from_utf16_lossy(&buf[..n]).starts_with(class.as_str()) {
        out.push(hwnd);
    }
    true.into()
}

impl WndProcShield {
    fn install(hwnd: HWND) -> Self {
        unsafe {
            let _ = hwnd;
            let mut targets = ("GpuiFast::".to_string(), Vec::new());
            let _ = EnumThreadWindows(
                GetCurrentThreadId(),
                Some(enum_same_class),
                LPARAM(&mut targets as *mut _ as _),
            );
            let swapped = targets
                .1
                .into_iter()
                .map(|window| {
                    let prev = GetWindowLongPtrW(window, GWLP_WNDPROC);
                    SetWindowLongPtrW(window, GWLP_WNDPROC, shield_wndproc as usize as isize);
                    (window, prev)
                })
                .collect();
            Self { swapped }
        }
    }
}

impl Drop for WndProcShield {
    fn drop(&mut self) {
        for (window, prev) in &self.swapped {
            unsafe {
                SetWindowLongPtrW(*window, GWLP_WNDPROC, *prev);
            }
        }
    }
}

static NEXT_ID: AtomicU64 = AtomicU64::new(1);

fn next_id() -> u64 {
    NEXT_ID.fetch_add(1, Ordering::SeqCst)
}

/// Builds the WebView2 on the calling (UI) thread: environment,
/// composition controller rooted at the surface visual, hardening, first
/// navigation.
fn build_view(id: u64, hwnd: HWND, visual: IDCompositionVisual, url: &str) -> Result<()> {
    let environment = create_environment(hwnd)?;
    // `CreateCoreWebView2CompositionController` is on `ICoreWebView2Environment3`.
    let environment3: ICoreWebView2Environment3 = environment
        .cast()
        .map_err(|e| Error::msg(format!("ICoreWebView2Environment3: {e}")))?;
    let controller = create_composition_controller(&environment3, hwnd)?;
    unsafe {
        controller
            .SetRootVisualTarget(&visual)
            .map_err(|e| Error::msg(format!("SetRootVisualTarget: {e}")))?;
    }
    let plain: ICoreWebView2Controller = controller
        .cast()
        .map_err(|e| Error::msg(format!("controller cast: {e}")))?;
    if let Ok(c3) = plain.cast::<ICoreWebView2Controller3>() {
        // The visual tree is in device pixels; raw pixels keeps bounds in the
        // same space instead of logical (DIP) coordinates.
        unsafe {
            let _ = c3.SetBoundsMode(COREWEBVIEW2_BOUNDS_MODE_USE_RAW_PIXELS);
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
                _environment: environment,
                hwnd,
                width: 1,
                height: 1,
            },
        );
    });
    Ok(())
}

/// Creates the WebView2 environment, pumping this thread until the completion
/// callback arrives.
fn create_environment(hwnd: HWND) -> Result<ICoreWebView2Environment> {
    let (tx, rx) = mpsc::channel();
    let user_data = user_data_dir();
    let options: ICoreWebView2EnvironmentOptions = CoreWebView2EnvironmentOptions::default().into();
    unsafe {
        CreateCoreWebView2EnvironmentWithOptions(
            PCWSTR::null(),
            &HSTRING::from(user_data.to_string_lossy().as_ref()),
            &options,
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
    wait_for(&rx, hwnd)?.map_err(|e| Error::msg(format!("webview2 environment creation: {e}")))
}

/// Creates the composition controller bound to `hwnd` (the window WebView2
/// uses for focus and keyboard routing), pumping until ready.
fn create_composition_controller(
    environment: &ICoreWebView2Environment3,
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
    let res = wait_for(&rx, hwnd);
    res?.map_err(|e| Error::msg(format!("webview2 composition controller creation: {e}")))
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
                        | COREWEBVIEW2_PERMISSION_KIND_GEOLOCATION
                        | COREWEBVIEW2_PERMISSION_KIND_CLIPBOARD_READ
                        | COREWEBVIEW2_PERMISSION_KIND_FILE_READ_WRITE
                        | COREWEBVIEW2_PERMISSION_KIND_MULTIPLE_AUTOMATIC_DOWNLOADS
                        | COREWEBVIEW2_PERMISSION_KIND_LOCAL_FONTS
                        | COREWEBVIEW2_PERMISSION_KIND_WINDOW_MANAGEMENT
                        | COREWEBVIEW2_PERMISSION_KIND_OTHER_SENSORS
                        | COREWEBVIEW2_PERMISSION_KIND_MIDI_SYSTEM_EXCLUSIVE_MESSAGES => {
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

impl Drop for WindowsWebView {
    fn drop(&mut self) {
        self.shared.gone.store(true, Ordering::SeqCst);
        VIEWS.with(|views| {
            if let Some(view) = views.borrow_mut().remove(&self.shared.id) {
                let _shield = WndProcShield::install(view.hwnd);
                unsafe {
                    let _ = view.plain.Close();
                }
            }
        });
    }
}
