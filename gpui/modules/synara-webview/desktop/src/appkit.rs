use std::ffi::c_void;
use std::sync::atomic::{AtomicBool, AtomicI64, AtomicU32, AtomicU64, AtomicUsize, Ordering};
use std::sync::{Mutex, Once, OnceLock};

use react_native_gpui::native_view::{
    appkit::{
        base::{id, nil, NO, YES},
        foundation::{NSPoint, NSRect, NSSize, NSString},
    },
    objective_c::{
        class, msg_send,
        runtime::{Class, Object, Sel},
        sel, sel_impl,
    },
    NativeViewHandle,
};

#[link(name = "WebKit", kind = "framework")]
// SAFETY: an empty block whose only job is to link the WebKit framework.
unsafe extern "C" {}
#[link(name = "AppKit", kind = "framework")]
// SAFETY: links AppKit for window, panel, menu and pasteboard APIs.
unsafe extern "C" {}
#[link(name = "Foundation", kind = "framework")]
// SAFETY: links Foundation for NSFileManager and friends.
unsafe extern "C" {}

#[link(name = "IOKit", kind = "framework")]
// SAFETY: links IOKit for the power-assertion APIs.
unsafe extern "C" {
    fn IOPMAssertionCreateWithName(
        assertion_type: id,
        level: u32,
        name: id,
        out_id: *mut u32,
    ) -> i32;
    fn IOPMAssertionRelease(assertion_id: u32) -> i32;
    fn IOPSGetTimeRemainingEstimate() -> f64;
}

/// The keep-awake preference and the live assertion, if held.
static KEEP_AWAKE_ENABLED: AtomicBool = AtomicBool::new(false);
static KEEP_AWAKE_ASSERTION: AtomicU32 = AtomicU32::new(0);

static LAST_RELOAD_UNIX_MS: AtomicI64 = AtomicI64::new(0);

const RELOAD_COOLDOWN_MS: i64 = 30_000;

/// Injected at document start: taps console errors and hydration progress,
/// and reports back over `webkit.messageHandlers.synara`. `stall` triggers a
/// native reload.
const WATCHDOG_JS: &str = r#"
(function () {
  if (window.__synaraWatchdog) return;
  window.__synaraWatchdog = true;
  var post = function (m) {
    try { window.webkit.messageHandlers.synara.postMessage(String(m)); } catch (e) {}
  };
  var clip = function (v) { return String(v).slice(0, 400); };
  var err = console.error, warn = console.warn;
  console.error = function () {
    post('console.error: ' + clip(Array.prototype.join.call(arguments, ' ')));
    return err.apply(console, arguments);
  };
  console.warn = function () {
    post('console.warn: ' + clip(Array.prototype.join.call(arguments, ' ')));
    return warn.apply(console, arguments);
  };
  window.addEventListener('error', function (e) {
    post('error: ' + clip(e.message) + ' @' + clip(e.filename) + ':' + e.lineno);
  });
  window.addEventListener('unhandledrejection', function (e) {
    post('rejection: ' + clip(e.reason));
  });
  var t0 = Date.now();
  var iv = window.setInterval(function () {
    var hydrated = !!document.querySelector('textarea, [contenteditable="true"], .cm-content');
    if (hydrated) {
      post('hydrated after ' + (Date.now() - t0) + 'ms');
      window.clearInterval(iv);
      return;
    }
    if (Date.now() - t0 > 15000) {
      var keys = [];
      try { for (var i = 0; i < localStorage.length; i++) keys.push(localStorage.key(i)); } catch (e) {}
      post('stall: not hydrated after 15s ' +
        'path=' + location.pathname +
        ' textLen=' + (document.body ? document.body.innerText.length : -1) +
        ' ls=' + keys.join(','));
      window.clearInterval(iv);
    }
  }, 1000);
})();
"#;

/// Injected at document start: installs `window.desktopBridge`, the same
/// surface Synara's Electron preload exposes. Calls travel to the native side
/// as `webkit.messageHandlers.synara` NSDictionary messages and resolve via
/// `window.__synaraResolve`. Event-style APIs (menu actions, window state)
/// are pushed through `window.__synaraEmit`.
const BRIDGE_JS: &str = r#"
(function () {
  if (window.__synaraBridge) return;
  window.__synaraBridge = true;
  var seq = 0;
  var pending = new Map();
  var listeners = new Map();

  window.__synaraResolve = function (id, ok, value) {
    var entry = pending.get(id);
    if (!entry) return;
    pending.delete(id);
    if (ok) entry.resolve(value);
    else entry.reject(new Error(String(value)));
  };

  window.__synaraEmit = function (name, payload) {
    var set = listeners.get(name);
    if (!set) return;
    set.forEach(function (fn) {
      try { fn(payload); } catch (e) {}
    });
  };

  var call = function (method, params) {
    return new Promise(function (resolve, reject) {
      var id = ++seq;
      pending.set(id, { resolve: resolve, reject: reject });
      try {
        var clean = params === undefined ? null : params;
        try { clean = JSON.parse(JSON.stringify(clean)); } catch (e) { clean = null; }
        window.webkit.messageHandlers.synara.postMessage({
          t: 'call', id: id, m: method, p: clean,
        });
      } catch (e) {
        pending.delete(id);
        reject(e);
      }
    });
  };

  var subscribe = function (name) {
    return function (listener) {
      var set = listeners.get(name);
      if (!set) { set = new Set(); listeners.set(name, set); }
      set.add(listener);
      return function () { set.delete(listener); };
    };
  };

  var closedBrowserState = function (threadId) {
    return {
      threadId: threadId || '', version: 0, open: false,
      activeTabId: null, tabs: [], lastError: 'browser panel unavailable in this shell',
    };
  };
  var unsupported = function (what) {
    return function () { return Promise.reject(new Error(what + ' unsupported in this shell')); };
  };
  var closedBrowser = function (method) {
    return function (input) {
      if (method === 'getState') return Promise.resolve(closedBrowserState(input && input.threadId));
      return Promise.resolve(closedBrowserState(input && input.threadId));
    };
  };
  var appSnapState = {
    platform: 'macos', supported: false, enabled: false, status: 'unsupported',
    shortcut: null, inputMonitoringPermission: 'unknown',
    screenRecordingPermission: 'unknown', message: 'AppSnap unavailable in this shell',
  };

  window.desktopBridge = {
    getWsUrl: function () { return null; },
    pickFolder: function () { return call('pickFolder'); },
    saveFile: function (input) { return call('saveFile', input); },
    confirm: function (message) { return call('confirm', { message: message }); },
    setTheme: function (theme) { return call('setTheme', { theme: theme }); },
    getAppIcon: function () { return call('getAppIcon'); },
    setAppIcon: function (icon) { return call('setAppIcon', { icon: icon }); },
    showContextMenu: function (items, position) { return call('showContextMenu', { items: items, position: position || null }); },
    openExternal: function (url) { return call('openExternal', { url: url }); },
    showInFolder: function (path) { return call('showInFolder', { path: path }); },
    shell: {
      showInFolder: function (path) { return call('showInFolder', { path: path }); },
    },
    clipboard: {
      writeImagePngDataUrl: function (dataUrl) { return call('clipboard.writeImagePngDataUrl', { dataUrl: dataUrl }); },
    },
    windowControls: {
      minimize: function () { return call('windowControls.minimize'); },
      toggleMaximize: function () { return call('windowControls.toggleMaximize'); },
      close: function () { return call('windowControls.close'); },
      getState: function () { return call('windowControls.getState'); },
      onState: subscribe('windowState'),
    },
    customTitleBar: {
      getState: function () {
        return Promise.resolve({ supported: false, preference: false, active: true, restartRequired: false });
      },
      setPreference: function (enabled) {
        return Promise.resolve({ supported: false, preference: enabled, active: true, restartRequired: false });
      },
      relaunch: function () { return Promise.resolve(); },
    },
    keepAwake: {
      getState: function () { return call('keepAwake.getState'); },
      setEnabled: function (enabled) { return call('keepAwake.setEnabled', { enabled: enabled }); },
      setRemoteAccessAllowed: function (allowed) { return call('keepAwake.setRemoteAccessAllowed', { allowed: allowed }); },
    },
    onMenuAction: subscribe('menuAction'),
    onQuitConfirmationRequest: subscribe('quitConfirmation'),
    replyQuitConfirmation: function () {},
    getZoomFactor: function () { return 1; },
    onZoomFactorChange: subscribe('zoomFactor'),
    getUpdateState: function () { return call('update.getState'); },
    checkForUpdates: function () { return call('update.check'); },
    downloadUpdate: function () { return call('update.download'); },
    installUpdate: function () { return call('update.install'); },
    onUpdateState: subscribe('updateState'),
    notifications: {
      isSupported: function () { return Promise.resolve(false); },
      show: function () { return Promise.resolve(false); },
    },
    appSnap: {
      captureCurrentApp: function (requestId) { return call('appSnap.captureCurrentApp', { requestId: requestId }); },
      cancelCapture: function (requestId) { return call('appSnap.cancelCapture', { requestId: requestId }); },
      getState: function (permissions) { return call('appSnap.getState', { permissions: permissions }); },
      setEnabled: function (enabled) { return call('appSnap.setEnabled', { enabled: enabled }); },
      checkShortcut: function (shortcut) { return call('appSnap.checkShortcut', { shortcut: shortcut }); },
      setShortcut: function (shortcut) { return call('appSnap.setShortcut', { shortcut: shortcut }); },
      requestPermissions: function (permissions) { return call('appSnap.requestPermissions', { permissions: permissions }); },
      startPermissionSetup: function (permissions) { return call('appSnap.startPermissionSetup', { permissions: permissions }); },
      listPendingCaptures: function () { return call('appSnap.listPendingCaptures'); },
      acknowledgeCapture: function (captureId) { return call('appSnap.acknowledgeCapture', { captureId: captureId }); },
      listWindows: function () { return call('appSnap.listWindows'); },
      captureWindow: function (input) { return call('appSnap.captureWindow', input); },
      openPermissionSettings: function (pane) { return call('appSnap.openPermissionSettings', { pane: pane }); },
      restartApp: function () { return call('appSnap.restartApp'); },
      showPermissionGuide: function (pane) { return call('appSnap.showPermissionGuide', { pane: pane }); },
      hidePermissionGuide: function () { return call('appSnap.hidePermissionGuide'); },
      onPermissionGuideState: subscribe('appSnapPermissionGuide'),
      onCaptured: subscribe('appSnapCaptured'),
      onError: subscribe('appSnapError'),
      onState: subscribe('appSnapState'),
    },
    storageMigration: {
      readSnapshot: function () { return null; },
      acknowledgeSnapshot: function () { return Promise.resolve(); },
    },
    browser: {
      open: closedBrowser('open'),
      close: closedBrowser('close'),
      hide: function () { return Promise.resolve(); },
      getState: closedBrowser('getState'),
      setPanelBounds: function () { return Promise.resolve(); },
      attachWebview: closedBrowser('attachWebview'),
      detachWebview: function () { return Promise.resolve(); },
      copyLink: function () { return Promise.resolve(); },
      copyScreenshotToClipboard: function () { return Promise.resolve(); },
      captureScreenshot: function () { return Promise.resolve(null); },
      capturePreview: function () { return Promise.resolve(null); },
      navigate: closedBrowser('navigate'),
      reload: closedBrowser('reload'),
      goBack: closedBrowser('goBack'),
      goForward: closedBrowser('goForward'),
      newTab: closedBrowser('newTab'),
      closeTab: closedBrowser('closeTab'),
      selectTab: closedBrowser('selectTab'),
      openDevTools: function () { return Promise.resolve(); },
      annotations: {
        get: function () { return Promise.resolve([]); },
        set: function () { return Promise.resolve(); },
        clear: function () { return Promise.resolve(); },
      },
      onState: subscribe('browserState'),
      onBrowserUseOpenPanelRequest: subscribe('browserUseOpenPanel'),
      onBrowserCopyLink: subscribe('browserCopyLink'),
    },
    computer: {
      setCursorStyle: function () { return Promise.resolve(); },
    },
    computerPreview: (function () {
      var count = 0;
      var b64ToBytes = function (s) {
        var bin = atob(s), out = new Uint8Array(bin.length);
        for (var i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
        return out;
      };
      var wrapped = subscribe('computerPreviewFrame');
      return {
        onFrame: function (listener) {
          var off = wrapped(function (f) {
            listener({ windowId: f.windowId, seq: f.seq, jpeg: b64ToBytes(f.jpeg) });
          });
          if (count++ === 0) call('cua.previewSubscribe');
          return function () {
            off();
            if (--count === 0) call('cua.previewUnsubscribe');
          };
        },
      };
    })(),
    audioLevel: {
      setSource: function () { return Promise.resolve(); },
      listMicrophones: function () { return Promise.resolve([]); },
      onLevel: subscribe('audioLevel'),
    },
    ping: function () { return call('ping'); },
  };

  // Self-test: string messages land on the native stderr log.
  call('ping').then(function (v) {
    window.webkit.messageHandlers.synara.postMessage('bridge: ping=' + v);
  }).catch(function (e) {
    window.webkit.messageHandlers.synara.postMessage('bridge: ping failed ' + e);
  });
  call('update.getState').then(function (v) {
    window.webkit.messageHandlers.synara.postMessage('bridge: updateState=' + JSON.stringify(v));
  }).catch(function (e) {
    window.webkit.messageHandlers.synara.postMessage('bridge: updateState failed ' + e);
  });
  call('update.check').then(function (v) {
    window.webkit.messageHandlers.synara.postMessage('bridge: updateCheck=' + JSON.stringify(v));
  }).catch(function (e) {
    window.webkit.messageHandlers.synara.postMessage('bridge: updateCheck failed ' + e);
  });
  window.desktopBridge.onUpdateState(function (v) {
    window.webkit.messageHandlers.synara.postMessage('bridge: updateEvent=' + JSON.stringify(v));
  });
  call('windowControls.getState').then(function (v) {
    window.webkit.messageHandlers.synara.postMessage('bridge: windowState=' + JSON.stringify(v));
  }).catch(function (e) {
    window.webkit.messageHandlers.synara.postMessage('bridge: windowState failed ' + e);
  });
})();
"#;

fn zero_frame() -> NSRect {
    NSRect::new(NSPoint::new(0., 0.), NSSize::new(0., 0.))
}

fn unix_ms() -> i64 {
    use std::time::{SystemTime, UNIX_EPOCH};
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis() as i64)
        .unwrap_or(0)
}

fn ns_str(s: &str) -> id {
    unsafe { NSString::alloc(nil).init_str(s) }
}

fn ns_string_text(string: id) -> String {
    unsafe {
        if string == nil {
            return String::new();
        }
        let utf8: *const std::ffi::c_char = msg_send![string, UTF8String];
        if utf8.is_null() {
            return String::new();
        }
        std::ffi::CStr::from_ptr(utf8)
            .to_string_lossy()
            .into_owned()
    }
}

/// Escapes a Rust string for splicing into a JS string literal.
fn js_escape(s: &str) -> String {
    let mut out = String::with_capacity(s.len() + 8);
    for ch in s.chars() {
        match ch {
            '\\' => out.push_str("\\\\"),
            '"' => out.push_str("\\\""),
            '\n' => out.push_str("\\n"),
            '\r' => out.push_str("\\r"),
            '\u{2028}' => out.push_str("\\u2028"),
            '\u{2029}' => out.push_str("\\u2029"),
            c if (c as u32) < 0x20 => out.push_str(&format!("\\u{:04x}", c as u32)),
            c => out.push(c),
        }
    }
    out
}

/// Reads `key` out of an NSDictionary as a String when the value is an
/// NSString or NSNumber.
unsafe fn dict_value(dict: id, key: &str) -> id {
    let k = ns_str(key);
    let v: id = msg_send![dict, objectForKey: k];
    let _: () = msg_send![k, release];
    v
}

unsafe fn dict_number(dict: id, key: &str) -> Option<i64> {
    let v = dict_value(dict, key);
    if v == nil {
        return None;
    }
    let is_num: bool = msg_send![v, isKindOfClass: class!(NSNumber)];
    if !is_num {
        return None;
    }
    let n: i64 = msg_send![v, longLongValue];
    Some(n)
}

unsafe fn dict_string(dict: id, key: &str) -> Option<String> {
    let v = dict_value(dict, key);
    if v == nil {
        return None;
    }
    let is_num: bool = msg_send![v, isKindOfClass: class!(NSNumber)];
    if is_num {
        let s: id = msg_send![v, stringValue];
        return Some(ns_string_text(s));
    }
    let is_str: bool = msg_send![v, isKindOfClass: class!(NSString)];
    if is_str {
        return Some(ns_string_text(v));
    }
    None
}

unsafe fn ns_number_i64(dict: id, key: &str) -> Option<i64> {
    let v = dict_value(dict, key);
    if v == nil {
        return None;
    }
    Some(msg_send![v, integerValue])
}

/// Delivers a bridge result back into the page: `__synaraResolve(id, ok, json)`.
/// `json` is a JS literal (e.g. `null`, `true`, `"x"`, `{...}`).
unsafe fn bridge_respond(view: id, call_id: i64, ok: bool, json: &str) {
    let script = format!(
        "window.__synaraResolve && window.__synaraResolve({call_id}, {ok}, {json});",
        ok = ok,
        json = json
    );
    let source = ns_str(&script);
    let _: () = msg_send![view, evaluateJavaScript: source completionHandler: nil];
    let _: () = msg_send![source, release];
}

/// Pushes an event into the page: `__synaraEmit(name, json)`.
unsafe fn bridge_emit(view: id, name: &str, json: &str) {
    let script = format!(
        "window.__synaraEmit && window.__synaraEmit(\"{}\", {json});",
        js_escape(name),
        json = json
    );
    let source = ns_str(&script);
    let _: () = msg_send![view, evaluateJavaScript: source completionHandler: nil];
    let _: () = msg_send![source, release];
}

fn json_string(s: &str) -> String {
    format!("\"{}\"", js_escape(s))
}

/// Builds an NSMenu from a `DesktopContextMenuItem[]` param array. Items carry
/// `{id, label, enabled?, children?}`; selection is reported via the handler's
/// `menu_value` ivar through the `synaraMenuAction:` method.
unsafe fn build_menu(items: id, handler: id) -> id {
    let menu: id = msg_send![class!(NSMenu), new];
    let count: usize = msg_send![items, count];
    for i in 0..count {
        let item_dict: id = msg_send![items, objectAtIndex: i];
        let children = dict_value(item_dict, "children");
        if children != nil {
            let submenu = build_menu(children, handler);
            let title = ns_str(&dict_string(item_dict, "label").unwrap_or_default());
            let empty = ns_str("");
            let item: id = msg_send![class!(NSMenuItem), alloc];
            // A parent item never fires its action: the submenu swallows clicks.
            let item: id = msg_send![item, initWithTitle: title action: sel!(synaraMenuAction:) keyEquivalent: empty];
            let _: () = msg_send![item, setSubmenu: submenu];
            let _: () = msg_send![menu, addItem: item];
            let _: () = msg_send![submenu, release];
            let _: () = msg_send![item, release];
            let _: () = msg_send![title, release];
            let _: () = msg_send![empty, release];
            continue;
        }
        let title = ns_str(&dict_string(item_dict, "label").unwrap_or_default());
        let value = dict_string(item_dict, "id").unwrap_or_default();
        let empty = ns_str("");
        let item: id = msg_send![class!(NSMenuItem), alloc];
        let item: id = msg_send![
            item,
            initWithTitle: title action: sel!(synaraMenuAction:) keyEquivalent: empty
        ];
        let rep = ns_str(&value);
        let _: () = msg_send![item, setRepresentedObject: rep];
        let _: () = msg_send![rep, release];
        let _: () = msg_send![item, setTarget: handler];
        if let Some(false) = dict_string(item_dict, "enabled").map(|s| s != "0" && s != "false") {
            let _: () = msg_send![item, setEnabled: NO];
        }
        let _: () = msg_send![menu, addItem: item];
        let _: () = msg_send![item, release];
        let _: () = msg_send![title, release];
        let _: () = msg_send![empty, release];
    }
    menu
}

/// Dispatches a `desktopBridge` call. `params` is an NSDictionary (or nil).
/// Returns the JSON literal to deliver back to the page.
unsafe fn bridge_dispatch(
    handler: &Object,
    view: id,
    method: &str,
    params: id,
) -> Result<String, String> {
    match method {
        "ping" => Ok(json_string("pong")),
        method if method.starts_with("appSnap.") => {
            let params_json = if params != nil {
                ns_to_json(params).unwrap_or_else(|| "null".into())
            } else {
                "null".into()
            };
            let out = appsnap_call(&method["appSnap.".len()..], &params_json);
            out
        }
        "getWsUrl" => Ok("null".into()),
        "getAppIcon" => Ok(json_string("default")),
        "setTheme" | "setAppIcon" => Ok("null".into()),
        "openExternal" => {
            let url = dict_string(params, "url").ok_or("missing url")?;
            let nsurl_string = ns_str(&url);
            let nsurl: id = msg_send![class!(NSURL), URLWithString: nsurl_string];
            let _: () = msg_send![nsurl_string, release];
            if nsurl == nil {
                return Err("invalid url".into());
            }
            let workspace: id = msg_send![class!(NSWorkspace), sharedWorkspace];
            let opened: bool = msg_send![workspace, openURL: nsurl];
            Ok(if opened { "true" } else { "false" }.into())
        }
        "showInFolder" => {
            let path = dict_string(params, "path").ok_or("missing path")?;
            let ns_path = ns_str(&path);
            let workspace: id = msg_send![class!(NSWorkspace), sharedWorkspace];
            let _: () = msg_send![
                workspace,
                selectFile: ns_path inFileViewerRootedAtPath: nil
            ];
            let _: () = msg_send![ns_path, release];
            Ok("null".into())
        }
        "confirm" => {
            let message = dict_string(params, "message").unwrap_or_default();
            let alert: id = msg_send![class!(NSAlert), new];
            let msg = ns_str(&message);
            let _: () = msg_send![alert, setMessageText: msg];
            let _: () = msg_send![msg, release];
            let ok_title = ns_str("OK");
            let cancel_title = ns_str("Cancel");
            let _: id = msg_send![alert, addButtonWithTitle: ok_title];
            let _: id = msg_send![alert, addButtonWithTitle: cancel_title];
            let _: () = msg_send![ok_title, release];
            let _: () = msg_send![cancel_title, release];
            let response: isize = msg_send![alert, runModal];
            let _: () = msg_send![alert, release];
            // NSAlertFirstButtonReturn == 1000
            Ok(if response == 1000 { "true" } else { "false" }.into())
        }
        "pickFolder" => {
            let panel: id = msg_send![class!(NSOpenPanel), openPanel];
            let _: () = msg_send![panel, setCanChooseFiles: NO];
            let _: () = msg_send![panel, setCanChooseDirectories: YES];
            let _: () = msg_send![panel, setAllowsMultipleSelection: NO];
            let response: isize = msg_send![panel, runModal];
            if response != 1 {
                return Ok("null".into());
            }
            let urls: id = msg_send![panel, URLs];
            let url_count: usize = if urls == nil {
                0
            } else {
                msg_send![urls, count]
            };
            if url_count == 0 {
                return Ok("null".into());
            }
            let first: id = msg_send![urls, objectAtIndex: 0usize];
            let path: id = msg_send![first, path];
            Ok(json_string(&ns_string_text(path)))
        }
        "saveFile" => {
            let contents = dict_string(params, "contents").ok_or("missing contents")?;
            let name = dict_string(params, "defaultFilename").unwrap_or_default();
            let panel: id = msg_send![class!(NSSavePanel), savePanel];
            let name_field = ns_str(&name);
            let _: () = msg_send![panel, setNameFieldStringValue: name_field];
            let _: () = msg_send![name_field, release];
            let response: isize = msg_send![panel, runModal];
            if response != 1 {
                return Ok("null".into());
            }
            let url: id = msg_send![panel, URL];
            if url == nil {
                return Ok("null".into());
            }
            let path: id = msg_send![url, path];
            let ns_contents = ns_str(&contents);
            let wrote: bool = msg_send![
                ns_contents,
                writeToURL: url atomically: YES encoding: 4usize error: nil
            ];
            let _: () = msg_send![ns_contents, release];
            if !wrote {
                return Err("write failed".into());
            }
            Ok(json_string(&ns_string_text(path)))
        }
        "clipboard.writeImagePngDataUrl" => {
            let data_url = dict_string(params, "dataUrl").ok_or("missing dataUrl")?;
            let b64 = data_url
                .splitn(2, ',')
                .nth(1)
                .filter(|_| data_url.starts_with("data:image/"))
                .ok_or("bad data url")?;
            let b64_ns = ns_str(b64);
            let data: id = msg_send![class!(NSData), alloc];
            let data: id = msg_send![data, initWithBase64EncodedString: b64_ns options: 0usize];
            let _: () = msg_send![b64_ns, release];
            if data == nil {
                return Err("bad base64".into());
            }
            let board: id = msg_send![class!(NSPasteboard), generalPasteboard];
            let _: () = msg_send![board, clearContents];
            let png_type = ns_str("public.png");
            let ok: bool = msg_send![board, setData: data forType: png_type];
            let _: () = msg_send![png_type, release];
            let _: () = msg_send![data, release];
            Ok(if ok { "true" } else { "false" }.into())
        }
        "windowControls.minimize" => {
            let window: id = msg_send![view, window];
            let _: () = msg_send![window, miniaturize: nil];
            Ok("null".into())
        }
        "windowControls.toggleMaximize" => {
            let window: id = msg_send![view, window];
            let _: () = msg_send![window, zoom: nil];
            let state = window_state_json(window);
            bridge_emit(view, "windowState", &state);
            Ok("null".into())
        }
        "windowControls.close" => {
            let window: id = msg_send![view, window];
            let _: () = msg_send![window, performClose: nil];
            Ok("null".into())
        }
        "windowControls.getState" => {
            let window: id = msg_send![view, window];
            Ok(window_state_json(window))
        }
        "showContextMenu" => {
            let items = dict_value(params, "items");
            if items == nil {
                return Ok("null".into());
            }
            let menu = build_menu(items, handler as *const Object as id);
            // Reset the selection slot before the (blocking) popup.
            (*(handler as *const Object as *mut Object)).set_ivar("menu_value", nil_id());
            // JSON null arrives as NSNull, not nil — only a real dictionary
            // carries coordinates.
            let position = dict_value(params, "position");
            let position_is_dict: bool = msg_send![position, isKindOfClass: class!(NSDictionary)];
            let point = if position_is_dict {
                NSPoint::new(
                    ns_number_f64(position, "x").unwrap_or(0.),
                    ns_number_f64(position, "y").unwrap_or(0.),
                )
            } else {
                let frame: NSRect = msg_send![view, frame];
                NSPoint::new(frame.size.width / 2., frame.size.height / 2.)
            };
            let _: bool =
                msg_send![menu, popUpMenuPositioningItem: nil atLocation: point inView: view];
            let selected: id = (*(handler as *const Object as *mut Object))
                .get_ivar::<usize>("menu_value")
                .to_owned() as id;
            // Read the payload before releasing the menu that owns the item.
            if selected == nil {
                let _: () = msg_send![menu, release];
                return Ok("null".into());
            }
            let rep: id = msg_send![selected, representedObject];
            let result = json_string(&ns_string_text(rep));
            let _: () = msg_send![menu, release];
            Ok(result)
        }
        "update.getState" => Ok(update_state_json()),
        "update.check" => Ok(update_check(view)),
        "update.download" => Ok(update_download(view)),
        "update.install" => Ok(update_install(view)),
        "keepAwake.getState" => Ok(keep_awake_json()),
        "keepAwake.setEnabled" => {
            let enabled = dict_value(params, "enabled") != nil
                && ns_number_i64(params, "enabled").unwrap_or(0) != 0;
            set_keep_awake(enabled);
            Ok(keep_awake_json())
        }
        "keepAwake.setRemoteAccessAllowed" => Ok(keep_awake_json()),
        "cua.previewSubscribe" => {
            frame_relay_write("subscribe\n");
            Ok("null".into())
        }
        "cua.previewUnsubscribe" => {
            frame_relay_write("unsubscribe\n");
            Ok("null".into())
        }
        _ => Err(format!("unhandled bridge method: {method}")),
    }
}

/// Holds or releases the user-idle sleep assertion to match `enabled`.
unsafe fn set_keep_awake(enabled: bool) {
    KEEP_AWAKE_ENABLED.store(enabled, Ordering::SeqCst);
    let current = KEEP_AWAKE_ASSERTION.load(Ordering::SeqCst);
    if enabled && current == 0 {
        // kIOPMAssertPreventUserIdleSystemSleep is CFSTR("PreventUserIdleSystemSleep").
        let assertion_type = ns_str("PreventUserIdleSystemSleep");
        let name = ns_str("Synara keep awake");
        let mut assertion_id: u32 = 0;
        // kIOPMAssertionLevelOn = 255
        let rc = IOPMAssertionCreateWithName(assertion_type, 255, name, &mut assertion_id);
        let _: () = msg_send![assertion_type, release];
        let _: () = msg_send![name, release];
        if rc == 0 {
            KEEP_AWAKE_ASSERTION.store(assertion_id, Ordering::SeqCst);
        }
    } else if !enabled && current != 0 {
        let _ = IOPMAssertionRelease(current);
        KEEP_AWAKE_ASSERTION.store(0, Ordering::SeqCst);
    }
}

fn keep_awake_json() -> String {
    let enabled = KEEP_AWAKE_ENABLED.load(Ordering::SeqCst);
    let active = KEEP_AWAKE_ASSERTION.load(Ordering::SeqCst) != 0;
    // IOPSGetTimeRemainingEstimate: -2 = unlimited (AC power).
    let remaining = unsafe { IOPSGetTimeRemainingEstimate() };
    let on_battery = remaining >= 0.0;
    format!("{{\"enabled\":{enabled},\"active\":{active},\"onBattery\":{on_battery}}}")
}

unsafe fn window_state_json(window: id) -> String {
    if window == nil {
        return "{\"isMaximized\":false,\"isFullscreen\":false}".into();
    }
    let zoomed: bool = msg_send![window, isZoomed];
    // NSWindowStyleMaskFullScreen = 1 << 14
    let mask: usize = msg_send![window, styleMask];
    let fullscreen = mask & (1 << 14) != 0;
    format!("{{\"isMaximized\":{zoomed},\"isFullscreen\":{fullscreen}}}")
}

unsafe fn ns_number_f64(dict: id, key: &str) -> Option<f64> {
    let v = dict_value(dict, key);
    if v == nil {
        return None;
    }
    Some(msg_send![v, doubleValue])
}

fn nil_id() -> usize {
    nil as usize
}

// ---------- updater (electron-builder feed, macOS zip swap) ----------

unsafe extern "C" {
    /// libdispatch exposes the main queue as a global (`&_dispatch_main_q` is
    /// what `dispatch_get_main_queue()` expands to), not a function symbol.
    static _dispatch_main_q: c_void;
    fn dispatch_async_f(
        queue: *const c_void,
        context: *mut c_void,
        work: extern "C" fn(*mut c_void),
    );
}

static UPDATE_STATE: OnceLock<Mutex<serde_json::Value>> = OnceLock::new();

/// scheme://host[:port] of the URL the host last loaded — the privileged
/// bridge only answers while the page still sits on it.
static ALLOWED_ORIGIN: Mutex<String> = Mutex::new(String::new());

fn update_state_cell() -> &'static Mutex<serde_json::Value> {
    UPDATE_STATE.get_or_init(|| Mutex::new(initial_update_state()))
}

/// The update feed: `SYNARA_UPDATE_FEED` overrides the GitHub releases base URL
/// the app probes for `latest-mac.yml`.
fn update_feed_base() -> String {
    std::env::var("SYNARA_UPDATE_FEED")
        .ok()
        .map(|s| s.trim_end_matches('/').to_string())
        .filter(|s| !s.is_empty())
        .unwrap_or_else(|| {
            "https://github.com/Emanuele-web04/synara/releases/latest/download".into()
        })
}

fn bundle_path() -> Option<String> {
    unsafe {
        let bundle: id = msg_send![class!(NSBundle), mainBundle];
        let path: id = msg_send![bundle, bundlePath];
        if path == nil {
            None
        } else {
            Some(ns_string_text(path))
        }
    }
}

/// Info.plist's `CFBundleShortVersionString`; `0.0.0` when the binary does not
/// run inside a packaged bundle.
fn bundle_version() -> String {
    unsafe {
        let bundle: id = msg_send![class!(NSBundle), mainBundle];
        let info: id = msg_send![bundle, infoDictionary];
        if info != nil {
            let key = ns_str("CFBundleShortVersionString");
            let value: id = msg_send![info, objectForKey: key];
            let _: () = msg_send![key, release];
            if value != nil {
                return ns_string_text(value);
            }
        }
    }
    "0.0.0".into()
}

/// `std::env::consts::ARCH` ("aarch64") → `DesktopRuntimeArch` ("arm64").
fn runtime_arch() -> &'static str {
    match std::env::consts::ARCH {
        "aarch64" => "arm64",
        "x86_64" => "x64",
        _ => "other",
    }
}

fn update_enabled() -> bool {
    bundle_path().map(|p| p.ends_with(".app")).unwrap_or(false)
}

fn initial_update_state() -> serde_json::Value {
    let enabled = update_enabled();
    serde_json::json!({
        "enabled": enabled,
        "status": if enabled { "idle" } else { "disabled" },
        "currentVersion": bundle_version(),
        "hostArch": runtime_arch(),
        "appArch": runtime_arch(),
        "runningUnderArm64Translation": false,
        "availableVersion": null,
        "downloadedVersion": null,
        "downloadPercent": null,
        "checkedAt": null,
        "message": if enabled { serde_json::Value::Null } else { serde_json::json!("updates need a packaged .app") },
        "errorContext": null,
        "canRetry": false,
        "installFailureCount": 0,
        "flavor": "production",
        "releaseUrl": null,
    })
}

fn update_state_json() -> String {
    update_state_cell()
        .lock()
        .map(|s| s.to_string())
        .unwrap_or_else(|_| "{}".into())
}

/// Sets state fields and pushes the whole `DesktopUpdateState` to the page.
/// `view` may be nil — then only the state is stored.
fn update_patch(view: id, patch: serde_json::Value) {
    let json = {
        let mut state = match update_state_cell().lock() {
            Ok(s) => s,
            Err(_) => return,
        };
        if let (Some(obj), Some(patch_obj)) = (state.as_object_mut(), patch.as_object()) {
            for (key, value) in patch_obj {
                obj.insert(key.clone(), value.clone());
            }
        }
        state.to_string()
    };
    if view != nil {
        update_emit_main(view, "updateState", &json);
    }
}

struct EmitCtx {
    view: usize,
    name: String,
    json: String,
}

extern "C" fn emit_on_main(ctx: *mut c_void) {
    let ctx = unsafe { Box::from_raw(ctx as *mut EmitCtx) };
    unsafe { bridge_emit(ctx.view as id, &ctx.name, &ctx.json) };
}

/// `bridge_emit`, but callable from any thread: WKWebView's
/// `evaluateJavaScript` wants the main queue.
fn update_emit_main(view: id, name: &str, json: &str) {
    let ctx = Box::new(EmitCtx {
        view: view as usize,
        name: name.into(),
        json: json.into(),
    });
    unsafe {
        dispatch_async_f(
            &_dispatch_main_q,
            Box::into_raw(ctx) as *mut c_void,
            emit_on_main,
        );
    }
}

fn iso_now() -> String {
    std::process::Command::new("date")
        .args(["-u", "+%Y-%m-%dT%H:%M:%SZ"])
        .output()
        .ok()
        .and_then(|o| String::from_utf8(o.stdout).ok())
        .map(|s| s.trim().to_string())
        .unwrap_or_default()
}

/// "1.6.10" → (1, 6, 10); non-numeric pieces parse as 0.
fn version_tuple(version: &str) -> (u64, u64, u64) {
    let mut parts = version.split('.').map(|p| {
        p.chars()
            .take_while(|c| c.is_ascii_digit())
            .collect::<String>()
            .parse::<u64>()
            .unwrap_or(0)
    });
    (
        parts.next().unwrap_or(0),
        parts.next().unwrap_or(0),
        parts.next().unwrap_or(0),
    )
}

struct FeedFile {
    url: String,
    sha512_b64: String,
    size: u64,
}

struct FeedManifest {
    version: String,
    files: Vec<FeedFile>,
}

/// The electron-builder `latest-mac.yml` shape: a `version` scalar plus a
/// `files:` list of `url`/`sha512`/`size`.
fn parse_update_manifest(text: &str) -> Option<FeedManifest> {
    let mut version = None;
    let mut files = Vec::new();
    let mut current: Option<FeedFile> = None;
    for line in text.lines() {
        let trimmed = line.trim();
        if trimmed.is_empty() || trimmed.starts_with('#') {
            continue;
        }
        if trimmed.starts_with("- ")
            || trimmed.starts_with("url:")
            || trimmed.starts_with("sha512:")
            || trimmed.starts_with("size:")
        {
            let body = trimmed.strip_prefix("- ").unwrap_or(trimmed);
            if let Some((key, value)) = body.split_once(':') {
                let value = value.trim().trim_matches(|c| c == '\'' || c == '"');
                match key.trim() {
                    "url" => {
                        if let Some(file) = current.take() {
                            files.push(file);
                        }
                        current = Some(FeedFile {
                            url: value.to_string(),
                            sha512_b64: String::new(),
                            size: 0,
                        });
                    }
                    "sha512" => {
                        if let Some(file) = current.as_mut() {
                            file.sha512_b64 = value.to_string();
                        }
                    }
                    "size" => {
                        if let Some(file) = current.as_mut() {
                            file.size = value.parse().unwrap_or(0);
                        }
                    }
                    _ => {}
                }
            }
            continue;
        }
        if let Some(file) = current.take() {
            files.push(file);
        }
        if let Some(rest) = trimmed.strip_prefix("version:") {
            version = Some(
                rest.trim()
                    .trim_matches(|c| c == '\'' || c == '"')
                    .to_string(),
            );
        }
    }
    if let Some(file) = current.take() {
        files.push(file);
    }
    version.map(|v| FeedManifest { version: v, files })
}

/// Updater staging files live in the per-user temp dir; `name` components are
/// sanitized so feed-provided versions can't escape it.
fn update_tmp_path(name: &str) -> String {
    std::env::temp_dir()
        .join(name)
        .to_string_lossy()
        .into_owned()
}

fn sanitize_component(s: &str) -> String {
    s.chars()
        .filter(|c| c.is_ascii_alphanumeric() || matches!(c, '.' | '-' | '_'))
        .collect()
}

fn sh_quote(s: &str) -> String {
    format!("'{}'", s.replace('\'', "'\\''"))
}

fn fetch_text(url: &str) -> Result<String, String> {
    let out = std::process::Command::new("curl")
        .args(["-fsSL", "--max-time", "30", url])
        .output()
        .map_err(|e| e.to_string())?;
    if !out.status.success() {
        return Err(format!("curl {} failed: {}", url, out.status));
    }
    String::from_utf8(out.stdout).map_err(|e| e.to_string())
}

/// base64 → lowercase hex (for sha512 comparison against `shasum` output).
fn b64_to_hex(input: &str) -> Option<String> {
    fn val(c: u8) -> Option<u8> {
        match c {
            b'A'..=b'Z' => Some(c - b'A'),
            b'a'..=b'z' => Some(c - b'a' + 26),
            b'0'..=b'9' => Some(c - b'0' + 52),
            b'+' => Some(62),
            b'/' => Some(63),
            _ => None,
        }
    }
    let bytes: Vec<u8> = input.bytes().filter(|b| !b"=\r\n\t ".contains(b)).collect();
    if bytes.is_empty() {
        return None;
    }
    let mut out = Vec::with_capacity(bytes.len() * 3 / 4 + 2);
    let mut chunks = bytes.chunks_exact(4);
    for chunk in &mut chunks {
        let n = ((val(chunk[0])? as u32) << 18)
            | ((val(chunk[1])? as u32) << 12)
            | ((val(chunk[2])? as u32) << 6)
            | (val(chunk[3])? as u32);
        out.extend_from_slice(&n.to_be_bytes()[1..]);
    }
    // A standard sha512 digest is 64 bytes → 86 base64 chars once padding is
    // stripped, so a 2- or 3-char tail is the norm, not an error.
    match chunks.remainder() {
        [a, b] => {
            let n = ((val(*a)? as u32) << 18) | ((val(*b)? as u32) << 12);
            out.push(n.to_be_bytes()[1]);
        }
        [a, b, c] => {
            let n =
                ((val(*a)? as u32) << 18) | ((val(*b)? as u32) << 12) | ((val(*c)? as u32) << 6);
            out.extend_from_slice(&n.to_be_bytes()[1..3]);
        }
        [] => {}
        _ => return None,
    }
    Some(out.iter().map(|b| format!("{b:02x}")).collect())
}

fn update_check(view: id) -> String {
    {
        let mut state = match update_state_cell().lock() {
            Ok(s) => s,
            Err(_) => return update_state_json(),
        };
        if state["enabled"] != serde_json::json!(true) {
            return state.to_string();
        }
    }
    update_patch(
        view,
        serde_json::json!({"status": "checking", "checkedAt": iso_now(), "message": null}),
    );
    let view = view as usize;
    std::thread::spawn(move || {
        let view = view as id;
        let manifest_url = format!("{}/latest-mac.yml", update_feed_base());
        let result = fetch_text(&manifest_url)
            .and_then(|text| parse_update_manifest(&text).ok_or_else(|| "bad manifest".into()));
        match result {
            Ok(manifest) => {
                let current = bundle_version();
                if version_tuple(&manifest.version) > version_tuple(&current) {
                    let release = format!(
                        "https://github.com/Emanuele-web04/synara/releases/tag/v{}",
                        manifest.version
                    );
                    update_patch(
                        view,
                        serde_json::json!({
                            "status": "available",
                            "availableVersion": manifest.version,
                            "releaseUrl": release,
                            "message": null,
                            "errorContext": null,
                            "canRetry": false,
                        }),
                    );
                } else {
                    update_patch(
                        view,
                        serde_json::json!({
                            "status": "up-to-date",
                            "availableVersion": null,
                            "message": null,
                            "errorContext": null,
                            "canRetry": false,
                        }),
                    );
                }
            }
            Err(err) => update_patch(
                view,
                serde_json::json!({
                    "status": "error",
                    "message": err,
                    "errorContext": "check",
                    "canRetry": true,
                }),
            ),
        }
    });
    update_state_json()
}

fn update_download(view: id) -> String {
    let available = {
        let state = match update_state_cell().lock() {
            Ok(s) => s,
            Err(_) => return update_result(false, false),
        };
        if state["status"] != serde_json::json!("available") {
            return update_result(false, false);
        }
        state["availableVersion"].as_str().unwrap_or("").to_string()
    };
    update_patch(
        view,
        serde_json::json!({"status": "downloading", "downloadPercent": 0}),
    );
    let target = update_tmp_path(&format!(
        "synara-update-{}.zip",
        sanitize_component(&available)
    ));
    let view = view as usize;
    std::thread::spawn(move || {
        let view = view as id;
        let manifest_url = format!("{}/latest-mac.yml", update_feed_base());
        let file = fetch_text(&manifest_url)
            .ok()
            .and_then(|t| parse_update_manifest(&t))
            .and_then(|m| {
                let arch = runtime_arch();
                m.files
                    .iter()
                    .find(|f| f.url.contains(arch))
                    .or_else(|| m.files.first())
                    .map(|f| (f.url.clone(), f.sha512_b64.clone(), f.size))
            });
        let Some((file_name, file_sha512, expected_size)) = file else {
            update_patch(
                view,
                serde_json::json!({"status":"error","message":"manifest unavailable","errorContext":"download","canRetry":true}),
            );
            return;
        };
        let url = format!("{}/{file_name}", update_feed_base());
        let expected_hex = b64_to_hex(&file_sha512);
        let target_dl = target.clone();
        let child = std::process::Command::new("curl")
            .args(["-fsSL", "-o", &target_dl, &url])
            .spawn();
        let Ok(mut child) = child else {
            update_patch(
                view,
                serde_json::json!({"status":"error","message":"download failed to start","errorContext":"download","canRetry":true}),
            );
            return;
        };
        while matches!(child.try_wait(), Ok(None)) {
            let downloaded = std::fs::metadata(&target_dl).map(|m| m.len()).unwrap_or(0);
            if expected_size > 0 {
                let pct = (downloaded * 100 / expected_size).min(99);
                update_patch(view, serde_json::json!({"downloadPercent": pct}));
            }
            std::thread::sleep(std::time::Duration::from_millis(400));
        }
        if !child.wait().map(|s| s.success()).unwrap_or(false) {
            update_patch(
                view,
                serde_json::json!({"status":"error","message":"download failed","errorContext":"download","canRetry":true,"downloadPercent":null}),
            );
            return;
        }
        let Some(hex) = expected_hex else {
            let _ = std::fs::remove_file(&target_dl);
            update_patch(
                view,
                serde_json::json!({"status":"error","message":"integrity metadata unavailable","errorContext":"download","canRetry":true}),
            );
            return;
        };
        let got = std::process::Command::new("shasum")
            .args(["-a", "512", &target_dl])
            .output()
            .ok()
            .and_then(|o| String::from_utf8(o.stdout).ok())
            .and_then(|s| s.split_whitespace().next().map(|h| h.to_string()));
        if got.as_deref() != Some(hex.as_str()) {
            let _ = std::fs::remove_file(&target_dl);
            update_patch(
                view,
                serde_json::json!({"status":"error","message":"sha512 mismatch","errorContext":"download","canRetry":true,"downloadPercent":null}),
            );
            return;
        }
        update_patch(
            view,
            serde_json::json!({
                "status": "downloaded",
                "downloadedVersion": serde_json::Value::String(available.clone()),
                "downloadPercent": null,
                "message": null,
                "errorContext": null,
                "canRetry": false,
            }),
        );
    });
    update_result(true, false)
}

fn update_install(view: id) -> String {
    let (version, target) = {
        let state = match update_state_cell().lock() {
            Ok(s) => s,
            Err(_) => return update_result(false, false),
        };
        if state["status"] != serde_json::json!("downloaded") {
            return update_result(false, false);
        }
        let version = state["downloadedVersion"]
            .as_str()
            .unwrap_or("")
            .to_string();
        (
            version.clone(),
            update_tmp_path(&format!(
                "synara-update-{}.zip",
                sanitize_component(&version)
            )),
        )
    };
    let Some(bundle) = bundle_path().filter(|p| p.ends_with(".app")) else {
        return update_result(false, false);
    };
    update_patch(
        view,
        serde_json::json!({"message": "installing; the app will relaunch"}),
    );
    let pid = std::process::id();
    let view = view as usize;
    std::thread::spawn(move || {
        let view = view as id;
        let dir = format!("{target}.dir");
        let _ = std::fs::remove_dir_all(&dir);
        let ok = std::process::Command::new("ditto")
            .args(["-x", "-k", &target, &dir])
            .status()
            .map(|s| s.success())
            .unwrap_or(false);
        let new_app = ok
            .then(|| {
                std::fs::read_dir(&dir)
                    .ok()?
                    .filter_map(|e| e.ok())
                    .find(|e| e.path().extension().map(|x| x == "app").unwrap_or(false))
                    .map(|e| e.path())
            })
            .flatten();
        let Some(new_app) = new_app else {
            update_patch(
                view,
                serde_json::json!({"status":"error","message":"extract failed","errorContext":"install","canRetry":true}),
            );
            return;
        };
        // Swap the running bundle out from under the process once it exits.
        // The installed bundle is moved aside first — never deleted — so a
        // partial or failed `ditto` restores the working app instead of
        // leaving nothing to relaunch.
        let bundle_q = sh_quote(&bundle);
        let prev_q = sh_quote(&format!("{bundle}.prev"));
        let src_q = sh_quote(&new_app.display().to_string());
        let script = format!(
            "#!/bin/sh\nwhile kill -0 {pid} 2>/dev/null; do sleep 0.2; done\nmv {bundle_q} {prev_q}\nif ditto {src_q} {bundle_q}; then rm -rf {prev_q} && open {bundle_q}; else rm -rf {bundle_q}; mv {prev_q} {bundle_q}; fi\n"
        );
        let script_path = update_tmp_path(&format!("synara-update-swap-{pid}.sh"));
        if std::fs::write(script_path, script).is_err() {
            update_patch(
                view,
                serde_json::json!({"status":"error","message":"swap script failed","errorContext":"install","canRetry":true}),
            );
            return;
        }
        let _ = std::process::Command::new("/usr/bin/nohup")
            .args(["/bin/sh", script_path])
            .spawn();
        std::thread::sleep(std::time::Duration::from_millis(500));
        std::process::exit(0);
    });
    update_result(true, false)
}

fn update_result(accepted: bool, completed: bool) -> String {
    format!(
        "{{\"accepted\":{accepted},\"completed\":{completed},\"state\":{}}}",
        update_state_json()
    )
}

extern "C" fn synara_menu_action(this: &Object, _cmd: Sel, sender: id) {
    unsafe {
        (*(this as *const Object as *mut Object)).set_ivar("menu_value", sender as usize);
    }
}

extern "C" fn did_receive_script_message(this: &Object, _cmd: Sel, _controller: id, message: id) {
    unsafe {
        let body: id = msg_send![message, body];
        let view = *this.get_ivar::<usize>("web_view") as id;

        let is_dict: bool = msg_send![body, isKindOfClass: class!(NSDictionary)];
        if is_dict {
            // Origin gate: a page that navigated away from the loaded origin
            // must not reach native calls.
            let current: id = msg_send![view, URL];
            let allowed = ALLOWED_ORIGIN.lock().map(|g| g.clone()).unwrap_or_default();
            if allowed.is_empty() || ns_url_origin(current) != allowed {
                return;
            }
            let call_id = ns_number_i64(body, "id").unwrap_or(0);
            let method = dict_string(body, "m").unwrap_or_default();
            let params = dict_value(body, "p");
            let result = bridge_dispatch(this, view, &method, params);
            let (ok, json) = match result {
                Ok(json) => (true, json),
                Err(err) => (false, json_string(&err)),
            };
            bridge_respond(view, call_id, ok, &json);
            return;
        }

        let text = ns_string_text(body);
        eprintln!("[synara-wv] {text}");
        if !text.starts_with("stall:") {
            return;
        }
        let now = unix_ms();
        let last = LAST_RELOAD_UNIX_MS.load(Ordering::SeqCst);
        if now - last < RELOAD_COOLDOWN_MS {
            eprintln!("[synara-wv] stall reported but reload on cooldown");
            return;
        }
        LAST_RELOAD_UNIX_MS.store(now, Ordering::SeqCst);
        eprintln!("[synara-wv] stall -> reloading webview");
        let _: id = msg_send![view, reload];
    }
}

/// A `WKScriptMessageHandler` that answers `desktopBridge` calls, logs
/// injected-script messages, and reloads the web view on hydration stalls.
/// The `menu_value` ivar holds the last `NSMenuItem` chosen from a bridge
/// context menu while `popUpMenuPositioningItem:` blocks.
fn handler_class() -> &'static Class {
    static REGISTER: Once = Once::new();
    REGISTER.call_once(|| {
        let mut declaration = react_native_gpui::native_view::objective_c::declare::ClassDecl::new(
            "SynaraScriptMessageHandler",
            class!(NSObject),
        )
        .expect("the handler class is declared once");
        declaration.add_ivar::<usize>("web_view");
        declaration.add_ivar::<usize>("menu_value");
        // SAFETY: the selectors and signatures are what WebKit/AppKit call.
        unsafe {
            declaration.add_method(
                sel!(userContentController:didReceiveScriptMessage:),
                did_receive_script_message as extern "C" fn(&Object, Sel, id, id),
            );
            declaration.add_method(
                sel!(synaraMenuAction:),
                synara_menu_action as extern "C" fn(&Object, Sel, id),
            );
        }
        declaration.register();
    });
    Class::get("SynaraScriptMessageHandler").expect("registered above")
}

/// Preview frame relay: the CUA sidecar streams `frame <wid> <seq> <len>\n`
/// + jpeg bytes on a unix socket; we re-emit them into the page as
/// `computerPreviewFrame` and write `subscribe`/`unsubscribe` back so the
/// tap helper only streams while a preview is open.
static FRAME_VIEW: AtomicUsize = AtomicUsize::new(0);
static FRAME_STREAM: OnceLock<Mutex<Option<std::os::unix::net::UnixStream>>> = OnceLock::new();
static FRAME_RELAY_ONCE: Once = Once::new();

fn frame_socket_path() -> Option<String> {
    if let Ok(path) = std::env::var("SYNARA_CUA_FRAME_SOCK") {
        return Some(path);
    }
    std::env::var("SYNARA_CUA_HOST_SOCKET")
        .ok()
        .map(|socket| format!("{socket}.frames"))
}

/// The relay capability: same value the sidecar expects — env first, then
/// the `{socket}.cap` file `spawn_cua_host` pointed the sidecar at.
fn cua_capability() -> String {
    if let Ok(cap) = std::env::var("SYNARA_CUA_HOST_CAPABILITY") {
        let cap = cap.trim().to_string();
        if !cap.is_empty() {
            return cap;
        }
    }
    std::env::var("SYNARA_CUA_HOST_SOCKET")
        .ok()
        .and_then(|socket| {
            std::fs::read_to_string(format!("{socket}.cap"))
                .ok()
                .map(|s| s.trim().to_string())
        })
        .filter(|s| !s.is_empty())
        .unwrap_or_default()
}

fn frame_relay_write(line: &str) {
    use std::io::Write;
    if let Some(stream) = &mut *frame_stream().lock().unwrap() {
        let _ = stream.write_all(line.as_bytes());
    }
}

fn frame_stream() -> &'static Mutex<Option<std::os::unix::net::UnixStream>> {
    FRAME_STREAM.get_or_init(|| Mutex::new(None))
}

fn frame_relay_start() {
    let Some(path) = frame_socket_path() else {
        return;
    };
    FRAME_RELAY_ONCE.call_once(move || {
        std::thread::spawn(move || loop {
            match std::os::unix::net::UnixStream::connect(&path) {
                Ok(stream) => {
                    if let Ok(writer) = stream.try_clone() {
                        *frame_stream().lock().unwrap() = Some(writer);
                    }
                    frame_relay_write(&format!(
                        "{{\"capability\":\"{}\"}}\n",
                        js_escape(&cua_capability())
                    ));
                    frame_relay_read(&stream);
                    *frame_stream().lock().unwrap() = None;
                }
                Err(_) => std::thread::sleep(std::time::Duration::from_secs(1)),
            }
        });
    });
}

fn frame_relay_read(stream: &std::os::unix::net::UnixStream) {
    use std::io::{BufRead, BufReader, Read};
    let mut reader = BufReader::new(stream.try_clone().unwrap());
    loop {
        let mut header = String::new();
        if reader.read_line(&mut header).unwrap_or(0) == 0 {
            return;
        }
        let mut parts = header.trim().split(' ');
        if parts.next() != Some("frame") {
            continue;
        }
        let (Some(wid), Some(seq), Some(len)) = (
            parts.next().and_then(|v| v.parse::<u32>().ok()),
            parts.next().and_then(|v| v.parse::<u32>().ok()),
            parts.next().and_then(|v| v.parse::<usize>().ok()),
        ) else {
            continue;
        };
        if len > 4 * 1024 * 1024 {
            return;
        }
        let mut jpeg = vec![0u8; len];
        if reader.read_exact(&mut jpeg).is_err() {
            return;
        }
        let view = FRAME_VIEW.load(Ordering::SeqCst) as id;
        if view != nil {
            let json = format!(
                "{{\"windowId\":{wid},\"seq\":{seq},\"jpeg\":\"{}\"}}",
                b64_encode(&jpeg)
            );
            update_emit_main(view, "computerPreviewFrame", &json);
        }
    }
}

// ---- AppSnap control relay ---------------------------------------------
// The sidecar serves `appSnap.*` bridge calls on <host-socket>.appsnap as
// JSON-lines (request {id, method, args} -> reply {id, result|error}) and
// broadcasts manager events on the same socket. Calls connect per request;
// a persistent second connection carries events into the page.

static APPSNAP_EVENTS_ONCE: Once = Once::new();
static APPSNAP_CALL_SEQ: AtomicU64 = AtomicU64::new(1);

fn appsnap_socket_path() -> Option<String> {
    if let Ok(path) = std::env::var("SYNARA_CUA_APPSNAP_SOCK") {
        return Some(path);
    }
    std::env::var("SYNARA_CUA_HOST_SOCKET")
        .ok()
        .map(|socket| format!("{socket}.appsnap"))
}

/// NSDictionary -> JSON string via NSJSONSerialization.
unsafe fn ns_to_json(object: id) -> Option<String> {
    let valid: bool = msg_send![class!(NSJSONSerialization), isValidJSONObject: object];
    if !valid {
        return None;
    }
    let data: id = msg_send![
        class!(NSJSONSerialization),
        dataWithJSONObject: object options: 0usize error: nil
    ];
    if data == nil {
        return None;
    }
    let text: id = msg_send![class!(NSString), alloc];
    let text: id = msg_send![text, initWithData: data encoding: 4usize];
    if text == nil {
        return None;
    }
    let out = ns_string_text(text);
    let _: () = msg_send![text, release];
    Some(out)
}

/// JSON string -> parsed object via NSJSONSerialization.
unsafe fn json_to_ns(json: &str) -> id {
    let source = ns_str(json);
    let data: id = msg_send![source, dataUsingEncoding: 4usize];
    let _: () = msg_send![source, release];
    if data == nil {
        return nil;
    }
    msg_send![
        class!(NSJSONSerialization),
        JSONObjectWithData: data options: 0usize error: nil
    ]
}

/// Synchronous AppSnap call. Runs on the main queue — invoked from
/// `bridge_dispatch` inside the WebKit script-message handler — so the ObjC
/// JSON decode is safe inline; dispatching it onto the main queue again would
/// deadlock.
fn appsnap_call(method: &str, params_json: &str) -> Result<String, String> {
    use std::io::{BufRead, BufReader, Write};
    use std::time::Duration;
    let path = appsnap_socket_path().ok_or("AppSnap relay not configured")?;
    let stream = std::os::unix::net::UnixStream::connect(&path)
        .map_err(|e| format!("AppSnap relay unreachable: {e}"))?;
    stream.set_read_timeout(Some(Duration::from_secs(30))).ok();
    let id = APPSNAP_CALL_SEQ.fetch_add(1, Ordering::SeqCst);
    let mut writer = stream.try_clone().map_err(|e| format!("clone: {e}"))?;
    let hello = format!("{{\"capability\":\"{}\"}}\n", js_escape(&cua_capability()));
    writer
        .write_all(hello.as_bytes())
        .map_err(|e| format!("write: {e}"))?;
    let line = format!(
        "{{\"id\":{id},\"method\":\"{}\",\"args\":{params_json}}}\n",
        js_escape(method)
    );
    writer
        .write_all(line.as_bytes())
        .map_err(|e| format!("write: {e}"))?;
    let mut reader = BufReader::new(stream);
    // Broadcast event lines share this connection's stream; skip them and any
    // stale reply until the line carrying this call's own id arrives.
    for _ in 0..16 {
        let mut reply = String::new();
        if reader.read_line(&mut reply).unwrap_or(0) == 0 {
            return Err("AppSnap relay closed".into());
        }
        let reply = reply.trim().to_string();
        if reply.is_empty() {
            continue;
        }
        unsafe {
            let dict = json_to_ns(&reply);
            if dict == nil {
                continue;
            }
            let reply_id = dict_number(dict, "id").unwrap_or(-1) as u64;
            if reply_id != id {
                continue; // event broadcast or another call's reply
            }
            let error = dict_value(dict, "error");
            if error != nil {
                return Err(dict_string(dict, "error").unwrap_or_else(|| "AppSnap error".into()));
            }
            let result = dict_value(dict, "result");
            if result == nil {
                return Ok("null".into());
            }
            return ns_to_json(result).ok_or_else(|| "result encode failed".into());
        }
    }
    Err("AppSnap reply lost in event stream".into())
}

fn appsnap_events_start() {
    let Some(path) = appsnap_socket_path() else {
        return;
    };
    APPSNAP_EVENTS_ONCE.call_once(move || {
        std::thread::spawn(move || loop {
            match std::os::unix::net::UnixStream::connect(&path) {
                Ok(mut stream) => {
                    use std::io::Write;
                    let hello =
                        format!("{{\"capability\":\"{}\"}}\n", js_escape(&cua_capability()));
                    if stream.write_all(hello.as_bytes()).is_ok() {
                        appsnap_events_read(stream);
                    }
                }
                Err(_) => std::thread::sleep(std::time::Duration::from_secs(1)),
            }
        });
    });
}

/// All ObjC work (JSON decode + bridge emit) happens on the main queue; the
/// reader thread only hands over the raw line.
extern "C" fn appsnap_event_on_main(ctx: *mut c_void) {
    let line = unsafe { Box::from_raw(ctx as *mut String) };
    unsafe {
        let dict = json_to_ns(line.trim());
        if dict == nil {
            return;
        }
        let Some(name) = dict_string(dict, "event") else {
            return;
        };
        let data = dict_value(dict, "data");
        let json = if data != nil {
            ns_to_json(data).unwrap_or_else(|| "null".into())
        } else {
            "null".into()
        };
        let view = FRAME_VIEW.load(Ordering::SeqCst) as id;
        if view != nil {
            bridge_emit(view, &name, &json);
        }
    }
}

fn appsnap_events_read(stream: std::os::unix::net::UnixStream) {
    use std::io::BufRead;
    let reader = std::io::BufReader::new(stream);
    for line in reader.lines() {
        let Ok(line) = line else { return };
        unsafe {
            dispatch_async_f(
                &_dispatch_main_q,
                Box::into_raw(Box::new(line)) as *mut c_void,
                appsnap_event_on_main,
            );
        }
    }
}

const B64_ALPHABET: &[u8; 64] = b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";

fn b64_encode(bytes: &[u8]) -> String {
    let mut out = String::with_capacity((bytes.len() + 2) / 3 * 4);
    for chunk in bytes.chunks(3) {
        let b = [
            chunk[0],
            *chunk.get(1).unwrap_or(&0),
            *chunk.get(2).unwrap_or(&0),
        ];
        let n = (b[0] as u32) << 16 | (b[1] as u32) << 8 | b[2] as u32;
        out.push(B64_ALPHABET[(n >> 18) as usize & 63] as char);
        out.push(B64_ALPHABET[(n >> 12) as usize & 63] as char);
        out.push(if chunk.len() > 1 {
            B64_ALPHABET[(n >> 6) as usize & 63] as char
        } else {
            '='
        });
        out.push(if chunk.len() > 2 {
            B64_ALPHABET[n as usize & 63] as char
        } else {
            '='
        });
    }
    out
}

pub fn web_view() -> NativeViewHandle {
    unsafe {
        // Ephemeral data store: a remembered-route + empty-snapshot combination
        // wedges the app's route restore on the splash, and nothing here needs
        // persistence anyway.
        let data_store: id = msg_send![class!(WKWebsiteDataStore), nonPersistentDataStore];
        let configuration: id = msg_send![class!(WKWebViewConfiguration), new];
        let _: () = msg_send![configuration, setWebsiteDataStore: data_store];

        let allocated: id = msg_send![class!(WKWebView), alloc];
        let view: id =
            msg_send![allocated, initWithFrame: zero_frame() configuration: configuration];
        let preferences: id = msg_send![configuration, preferences];
        let key = NSString::alloc(nil).init_str("developerExtrasEnabled");
        let number: id = msg_send![class!(NSNumber), numberWithBool: YES];
        let _: () = msg_send![preferences, setValue: number forKey: key];
        let _: () = msg_send![key, release];
        let _: () = msg_send![view, setInspectable: YES];

        let controller: id = msg_send![configuration, userContentController];
        for source_text in [WATCHDOG_JS, BRIDGE_JS] {
            let source = NSString::alloc(nil).init_str(source_text);
            let user_script: id = msg_send![class!(WKUserScript), alloc];
            // 0 = WKUserScriptInjectionTimeAtDocumentStart
            let user_script: id = msg_send![
                user_script,
                initWithSource: source injectionTime: 0usize forMainFrameOnly: YES
            ];
            let _: () = msg_send![controller, addUserScript: user_script];
            let _: () = msg_send![user_script, release];
            let _: () = msg_send![source, release];
        }

        let handler: id = msg_send![handler_class(), new];
        (*(handler as *mut Object)).set_ivar("web_view", view as usize);
        let name = NSString::alloc(nil).init_str("synara");
        let _: () = msg_send![controller, addScriptMessageHandler: handler name: name];
        let _: () = msg_send![name, release];
        let _: () = msg_send![handler, release];

        FRAME_VIEW.store(view as usize, Ordering::SeqCst);
        frame_relay_start();
        appsnap_events_start();

        NativeViewHandle::from_owned_nsview(view as *mut std::ffi::c_void)
    }
}

/// scheme://host[:port] of an `NSURL`, or "" when any component is absent.
unsafe fn ns_url_origin(nsurl: id) -> String {
    if nsurl == nil {
        return String::new();
    }
    let scheme: id = msg_send![nsurl, scheme];
    let host: id = msg_send![nsurl, host];
    if scheme == nil || host == nil {
        return String::new();
    }
    let mut origin = format!("{}://{}", ns_string_text(scheme), ns_string_text(host));
    let port: id = msg_send![nsurl, port];
    if port != nil {
        let n: i64 = msg_send![port, integerValue];
        origin.push_str(&format!(":{n}"));
    }
    origin
}

pub fn load_url(view: NativeViewHandle, url: &str) {
    unsafe {
        let url_string = NSString::alloc(nil).init_str(url);
        let nsurl: id = msg_send![class!(NSURL), URLWithString: url_string];
        if let Ok(mut guard) = ALLOWED_ORIGIN.lock() {
            *guard = ns_url_origin(nsurl);
        }
        let request: id = msg_send![class!(NSURLRequest), requestWithURL: nsurl];
        let _: id = msg_send![view.as_nsview() as id, loadRequest: request];
        let _: () = msg_send![url_string, release];
    }
}
