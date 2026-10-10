// FILE: WindowMaterial.m
// Purpose: Node-API addon that sets the macOS window-server background blur radius for a
//          BrowserWindow, so the translucent shell can show the desktop at any blur amount.
// Layer: Desktop native (macOS only, loaded in the Electron main process)
// Exports: setBackgroundBlurRadius(nativeWindowHandle: Buffer, radius: number) => boolean
//
// Electron only exposes vibrancy on/off. The adjustable blur behind a window comes from
// the private CGSSetWindowBackgroundBlurRadius call (the one iTerm2 and Ghostty use).
// WindowServer only accepts it from the connection that owns the window, so it has to
// run in-process rather than in the AppSnap helper. Both symbols are resolved with dlsym:
// if a future macOS drops them the addon still loads and reports failure, and the caller
// falls back to plain vibrancy.

#import <AppKit/AppKit.h>
#include <dlfcn.h>
#include <stdbool.h>
#include <stddef.h>
#include <stdint.h>

// ─── Node-API (ABI-stable C surface, declared here to avoid a headers dependency) ───

typedef struct napi_env__* napi_env;
typedef struct napi_value__* napi_value;
typedef struct napi_callback_info__* napi_callback_info;
typedef int napi_status;
typedef napi_value (*napi_callback)(napi_env env, napi_callback_info info);

extern napi_status napi_get_cb_info(napi_env env, napi_callback_info info, size_t* argc,
                                    napi_value* argv, napi_value* this_arg, void** data);
extern napi_status napi_get_buffer_info(napi_env env, napi_value value, void** data,
                                        size_t* length);
extern napi_status napi_get_value_int32(napi_env env, napi_value value, int32_t* result);
extern napi_status napi_get_boolean(napi_env env, bool value, napi_value* result);
extern napi_status napi_create_function(napi_env env, const char* utf8name, size_t length,
                                        napi_callback cb, void* data, napi_value* result);
extern napi_status napi_set_named_property(napi_env env, napi_value object, const char* utf8name,
                                           napi_value value);

// ─── Private window-server calls ───

typedef int32_t CGSConnectionID;
typedef int32_t (*CGSMainConnectionIDFn)(void);
typedef int32_t (*CGSSetWindowBackgroundBlurRadiusFn)(CGSConnectionID connection,
                                                       int32_t windowNumber, int32_t radius);

static const int32_t kMaxBlurRadius = 100;

static bool setBlurRadius(NSWindow* window, int32_t radius) {
  static CGSMainConnectionIDFn mainConnectionID = NULL;
  static CGSSetWindowBackgroundBlurRadiusFn setWindowBlurRadius = NULL;
  static bool resolved = false;
  if (!resolved) {
    resolved = true;
    mainConnectionID = (CGSMainConnectionIDFn)dlsym(RTLD_DEFAULT, "CGSMainConnectionID");
    setWindowBlurRadius = (CGSSetWindowBackgroundBlurRadiusFn)dlsym(
        RTLD_DEFAULT, "CGSSetWindowBackgroundBlurRadius");
  }
  if (mainConnectionID == NULL || setWindowBlurRadius == NULL) return false;

  // The blur only shows through a non-opaque window with a clear background. A fully clear
  // background (alpha 0) with a native shadow makes macOS draw a gap between the window
  // border and its contents, so keep a sliver of alpha and have the shadow recomputed.
  [window setOpaque:NO];
  [window setBackgroundColor:[[NSColor clearColor] colorWithAlphaComponent:0.01]];
  bool ok = setWindowBlurRadius(mainConnectionID(), (int32_t)[window windowNumber], radius) == 0;
  [window setHasShadow:YES];
  [window invalidateShadow];
  return ok;
}

static napi_value SetBackgroundBlurRadius(napi_env env, napi_callback_info info) {
  size_t argc = 2;
  napi_value argv[2] = {NULL, NULL};
  bool ok = false;

  void* handleData = NULL;
  size_t handleLength = 0;
  int32_t radius = 0;
  if (napi_get_cb_info(env, info, &argc, argv, NULL, NULL) == 0 && argc == 2 &&
      napi_get_buffer_info(env, argv[0], &handleData, &handleLength) == 0 &&
      handleLength == sizeof(void*) && napi_get_value_int32(env, argv[1], &radius) == 0) {
    // BrowserWindow.getNativeWindowHandle() on macOS is a buffer holding an NSView*.
    NSView* view = (__bridge NSView*)(*(void**)handleData);
    NSWindow* window = [view window];
    if (window != nil) {
      if (radius < 0) radius = 0;
      if (radius > kMaxBlurRadius) radius = kMaxBlurRadius;
      ok = setBlurRadius(window, radius);
    }
  }

  napi_value result = NULL;
  napi_get_boolean(env, ok, &result);
  return result;
}

__attribute__((visibility("default"))) napi_value napi_register_module_v1(napi_env env,
                                                                         napi_value exports) {
  napi_value fn = NULL;
  if (napi_create_function(env, "setBackgroundBlurRadius", (size_t)-1, SetBackgroundBlurRadius,
                           NULL, &fn) == 0) {
    napi_set_named_property(env, exports, "setBackgroundBlurRadius", fn);
  }
  return exports;
}
