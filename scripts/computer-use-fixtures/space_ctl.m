// space-ctl: Space enumeration and verified-mutation helper for agent window
// isolation research on macOS. Read-only subcommands are safe anywhere.
// Mutating subcommands act only on exactly the ids given on the command line.
//
// Usage:
//   space-ctl list                         managed Spaces per display (attached)
//   space-ctl all-spaces                   every Space object incl. orphans (type-3)
//   space-ctl active-space                 active Space id of the main connection
//   space-ctl windows [--pid <pid>]        CGWindowList window ids
//   space-ctl window-spaces <wid> [...]    Space ids each window belongs to
//   space-ctl create-orphan                create an unmanaged type-3 Space
//   space-ctl destroy <spaceId>            destroy an orphan Space
//   space-ctl show <spaceId> [...]         probe: ask WindowServer to attach
//   space-ctl move <spaceId> <wid> [...]   probe: move windows into a Space
//   space-ctl add <spaceId> <wid> [...]    probe: add windows to a Space
//   space-ctl remove <spaceId> <wid> [...] probe: remove windows from a Space
//   space-ctl set-current <spaceId>        probe: switch the active Space
//   space-ctl set-current-instant <id>     switch without the slide animation
//                                        (SLSDisableUpdate/SLSReenableUpdate)
//
// Exit codes: 0 ok, 1 usage/arg error, 2 call returned an error or the
// post-call read-back did not confirm the requested state.
//
// Verified on macOS 26.5.2 (arm64, SIP enabled): only the read commands plus
// create-orphan/destroy actually change anything. show/move/add/remove and
// set-current are entitlement-gated no-ops for an unentitled process — the
// WindowServer returns success (or ignores the call) without applying it, so
// every mutating command performs a read-back and exits non-zero when the
// effect did not land. "verified=0" is the honest answer, not a crash.
//
// Orphan (type-3) spaces are real SpaceServer objects visible via
// SLSCopySpaces, but they are never listed by SLSCopyManagedDisplaySpaces,
// cannot become the active Space, and do not accept windows. They are NOT a
// usable agent Space — create/destroy exist here to document that boundary.
#include <stdio.h>
#include <dlfcn.h>
#include <stdlib.h>
#include <string.h>
#include <CoreFoundation/CoreFoundation.h>
#include <CoreGraphics/CoreGraphics.h>

typedef int (*IntVoid)(void);
typedef CFTypeRef (*CopyManaged)(int);
typedef CFTypeRef (*CopySpacesForWindows)(int, int, CFArrayRef);
typedef CFTypeRef (*CopyWindowInfo)(uint32_t, uint32_t);
typedef CFTypeRef (*CopySpaces)(int, uint32_t);
typedef void (*MoveWindows)(int, CFArrayRef, uint64_t);
typedef void (*AddWindows)(int, CFArrayRef, CFArrayRef);
typedef int (*SetCurrent)(int, CFStringRef, uint64_t);
typedef uint64_t (*GetActiveSpace)(int);
typedef CFStringRef (*CopyDisplayForSpace)(int, uint64_t);
typedef uint64_t (*SpaceCreate)(int, uint32_t, uint32_t);
typedef int (*SpaceDestroy)(int, uint64_t);
typedef int (*SpaceGetType)(int, uint64_t);
typedef void (*ShowSpaces)(int, CFArrayRef);
typedef void (*UpdateGate)(int);

static IntVoid cgs_cid;
static CopyManaged copy_managed;
static CopySpacesForWindows spaces_for_windows;
static CopyWindowInfo copy_window_info;
static CopySpaces copy_spaces;
static MoveWindows move_windows;
static AddWindows add_windows;
static AddWindows remove_windows;
static SetCurrent set_current;
static GetActiveSpace get_active_space;
static CopyDisplayForSpace copy_display_for_space;
static SpaceCreate space_create;
static SpaceDestroy space_destroy;
static SpaceGetType space_get_type;
static ShowSpaces show_spaces;
static UpdateGate disable_update;
static UpdateGate reenable_update;

static int load(void *sky) {
  cgs_cid = (IntVoid)dlsym(sky, "CGSMainConnectionID");
  copy_managed = (CopyManaged)dlsym(sky, "SLSCopyManagedDisplaySpaces");
  spaces_for_windows = (CopySpacesForWindows)dlsym(sky, "SLSCopySpacesForWindows");
  copy_spaces = (CopySpaces)dlsym(sky, "SLSCopySpaces");
  move_windows = (MoveWindows)dlsym(sky, "SLSMoveWindowsToManagedSpace");
  add_windows = (AddWindows)dlsym(sky, "SLSAddWindowsToSpaces");
  remove_windows = (AddWindows)dlsym(sky, "SLSRemoveWindowsFromSpaces");
  set_current = (SetCurrent)dlsym(sky, "SLSManagedDisplaySetCurrentSpace");
  get_active_space = (GetActiveSpace)dlsym(sky, "SLSGetActiveSpace");
  copy_display_for_space = (CopyDisplayForSpace)dlsym(sky, "SLSCopyManagedDisplayForSpace");
  space_create = (SpaceCreate)dlsym(sky, "SLSSpaceCreate");
  space_destroy = (SpaceDestroy)dlsym(sky, "SLSSpaceDestroy");
  space_get_type = (SpaceGetType)dlsym(sky, "SLSSpaceGetType");
  show_spaces = (ShowSpaces)dlsym(sky, "SLSShowSpaces");
  disable_update = (UpdateGate)dlsym(sky, "SLSDisableUpdate");
  reenable_update = (UpdateGate)dlsym(sky, "SLSReenableUpdate");
  copy_window_info = (CopyWindowInfo)dlsym(RTLD_DEFAULT, "CGWindowListCopyWindowInfo");
  return cgs_cid && copy_managed && spaces_for_windows;
}

static CFArrayRef u64_array(int argc, char **argv, int from) {
  CFMutableArrayRef out = CFArrayCreateMutable(NULL, 0, &kCFTypeArrayCallBacks);
  for (int i = from; i < argc; i++) {
    long long v = strtoll(argv[i], NULL, 10);
    if (v <= 0) { CFRelease(out); return NULL; }
    CFNumberRef n = CFNumberCreate(NULL, kCFNumberSInt64Type, &v);
    CFArrayAppendValue(out, n);
    CFRelease(n);
  }
  return out;
}

// Is `space` in the set of ids SLSCopySpaces reports (mask 0xf = every object
// the SpaceServer will admit exists for this connection)?
static int space_in_copy_spaces(int cid, uint64_t space) {
  if (!copy_spaces) return 0;
  CFArrayRef all = (CFArrayRef)copy_spaces(cid, 0xf);
  if (!all) return 0;
  int found = 0;
  for (CFIndex i = 0; i < CFArrayGetCount(all); i++) {
    CFNumberRef v = (CFNumberRef)CFArrayGetValueAtIndex(all, i);
    long long n = 0; CFNumberGetValue(v, kCFNumberSInt64Type, &n);
    if ((uint64_t)n == space) { found = 1; break; }
  }
  CFRelease(all);
  return found;
}

// Is `space` attached to a managed display (the real "is a usable Space" test)?
static int space_is_managed(int cid, uint64_t space) {
  CFArrayRef displays = (CFArrayRef)copy_managed(cid);
  if (!displays) return 0;
  int found = 0;
  for (CFIndex i = 0; i < CFArrayGetCount(displays) && !found; i++) {
    CFDictionaryRef d = (CFDictionaryRef)CFArrayGetValueAtIndex(displays, i);
    CFArrayRef spaces = (CFArrayRef)CFDictionaryGetValue(d, CFSTR("Spaces"));
    if (!spaces) continue;
    for (CFIndex j = 0; j < CFArrayGetCount(spaces); j++) {
      CFDictionaryRef s = (CFDictionaryRef)CFArrayGetValueAtIndex(spaces, j);
      CFNumberRef sid = (CFNumberRef)CFDictionaryGetValue(s, CFSTR("ManagedSpaceID"));
      long long n = 0;
      if (sid) CFNumberGetValue(sid, kCFNumberSInt64Type, &n);
      if ((uint64_t)n == space) { found = 1; break; }
    }
  }
  CFRelease(displays);
  return found;
}

// Re-queries the membership of every requested window and reports whether
// they all sit on `space` (want_present=1) or all avoid it (want_present=0).
static int space_membership_ok(int cid, CFArrayRef windows, uint64_t space, int want_present) {
  CFArrayRef result = (CFArrayRef)spaces_for_windows(cid, 0x7, windows);
  if (!result) return 0;
  CFIndex want = want_present ? CFArrayGetCount(windows) : 0;
  CFIndex hits = 0;
  for (CFIndex i = 0; i < CFArrayGetCount(result); i++) {
    CFNumberRef v = (CFNumberRef)CFArrayGetValueAtIndex(result, i);
    long long n = 0; CFNumberGetValue(v, kCFNumberSInt64Type, &n);
    if ((uint64_t)n == space) hits++;
  }
  CFRelease(result);
  return hits == want;
}

static void pump_events(void) {
  // Give the WindowServer a beat to apply asynchronous mutations before we
  // read state back.
  while (CFRunLoopRunInMode(kCFRunLoopDefaultMode, 0.15, true) == kCFRunLoopRunHandledSource) {}
}

int main(int argc, char **argv) {
  setbuf(stdout, NULL);
  if (argc < 2) { printf("usage: space-ctl list|all-spaces|active-space|windows|window-spaces|create-orphan|destroy|show|move|add|remove|set-current|set-current-instant ...\n"); return 1; }
  void *sky = dlopen("/System/Library/PrivateFrameworks/SkyLight.framework/SkyLight", RTLD_NOW | RTLD_GLOBAL);
  if (!sky) { printf("SkyLight dlopen failed: %s\n", dlerror()); return 2; }
  if (!load(sky)) { printf("required symbols missing\n"); return 2; }
  int cid = cgs_cid();
  const char *cmd = argv[1];

  if (!strcmp(cmd, "list")) {
    CFArrayRef displays = (CFArrayRef)copy_managed(cid);
    if (!displays) { printf("no displays\n"); return 2; }
    for (CFIndex i = 0; i < CFArrayGetCount(displays); i++) {
      CFDictionaryRef d = (CFDictionaryRef)CFArrayGetValueAtIndex(displays, i);
      CFStringRef name = (CFStringRef)CFDictionaryGetValue(d, CFSTR("Display Identifier"));
      char buf[256] = {0};
      if (name) CFStringGetCString(name, buf, sizeof(buf), kCFStringEncodingUTF8);
      printf("display %s\n", buf);
      CFArrayRef spaces = (CFArrayRef)CFDictionaryGetValue(d, CFSTR("Spaces"));
      if (!spaces) continue;
      for (CFIndex j = 0; j < CFArrayGetCount(spaces); j++) {
        CFDictionaryRef s = (CFDictionaryRef)CFArrayGetValueAtIndex(spaces, j);
        CFNumberRef sid = (CFNumberRef)CFDictionaryGetValue(s, CFSTR("ManagedSpaceID"));
        CFNumberRef type = (CFNumberRef)CFDictionaryGetValue(s, CFSTR("type"));
        long long sidv = -1, tv = -1;
        if (sid) CFNumberGetValue(sid, kCFNumberSInt64Type, &sidv);
        if (type) CFNumberGetValue(type, kCFNumberSInt64Type, &tv);
        printf("  space %lld type=%lld\n", sidv, tv);
      }
    }
    CFRelease(displays);
    return 0;
  }

  if (!strcmp(cmd, "all-spaces")) {
    if (!copy_spaces || !space_get_type) { printf("SLSCopySpaces/SLSGetSpaceType missing\n"); return 2; }
    CFArrayRef all = (CFArrayRef)copy_spaces(cid, 0xf);
    if (!all) { printf("SLSCopySpaces failed\n"); return 2; }
    for (CFIndex i = 0; i < CFArrayGetCount(all); i++) {
      CFNumberRef v = (CFNumberRef)CFArrayGetValueAtIndex(all, i);
      long long n = 0; CFNumberGetValue(v, kCFNumberSInt64Type, &n);
      int t = space_get_type(cid, (uint64_t)n);
      printf("space %lld type=%d managed=%d\n", n, t, space_is_managed(cid, (uint64_t)n));
    }
    CFRelease(all);
    return 0;
  }

  if (!strcmp(cmd, "active-space")) {
    if (!get_active_space) { printf("SLSGetActiveSpace unavailable\n"); return 2; }
    printf("active space %llu\n", (unsigned long long)get_active_space(cid));
    return 0;
  }

  if (!strcmp(cmd, "windows")) {
    if (!copy_window_info) { printf("CGWindowListCopyWindowInfo unavailable\n"); return 2; }
    int filterPid = 0;
    for (int i = 2; i + 1 < argc; i++) if (!strcmp(argv[i], "--pid")) filterPid = atoi(argv[i + 1]);
    CFArrayRef list = (CFArrayRef)copy_window_info(17, 0); // exclude desktop elements
    if (!list) { printf("no windows\n"); return 2; }
    for (CFIndex i = 0; i < CFArrayGetCount(list); i++) {
      CFDictionaryRef w = (CFDictionaryRef)CFArrayGetValueAtIndex(list, i);
      CFNumberRef pidRef = (CFNumberRef)CFDictionaryGetValue(w, CFSTR("kCGWindowOwnerPID"));
      CFNumberRef numRef = (CFNumberRef)CFDictionaryGetValue(w, CFSTR("kCGWindowNumber"));
      CFStringRef titleRef = (CFStringRef)CFDictionaryGetValue(w, CFSTR("kCGWindowName"));
      int pidv = -1, numv = -1;
      if (pidRef) CFNumberGetValue(pidRef, kCFNumberIntType, &pidv);
      if (numRef) CFNumberGetValue(numRef, kCFNumberIntType, &numv);
      CFNumberRef layerRef = (CFNumberRef)CFDictionaryGetValue(w, CFSTR("kCGWindowLayer"));
      int layerv = -1;
      if (layerRef) CFNumberGetValue(layerRef, kCFNumberIntType, &layerv);
      CFDictionaryRef boundsRef = (CFDictionaryRef)CFDictionaryGetValue(w, CFSTR("kCGWindowBounds"));
      double bx = 0, by = 0, bw = 0, bh = 0;
      if (boundsRef) {
        CFNumberRef v;
        if ((v = (CFNumberRef)CFDictionaryGetValue(boundsRef, CFSTR("X"))))
          CFNumberGetValue(v, kCFNumberDoubleType, &bx);
        if ((v = (CFNumberRef)CFDictionaryGetValue(boundsRef, CFSTR("Y"))))
          CFNumberGetValue(v, kCFNumberDoubleType, &by);
        if ((v = (CFNumberRef)CFDictionaryGetValue(boundsRef, CFSTR("Width"))))
          CFNumberGetValue(v, kCFNumberDoubleType, &bw);
        if ((v = (CFNumberRef)CFDictionaryGetValue(boundsRef, CFSTR("Height"))))
          CFNumberGetValue(v, kCFNumberDoubleType, &bh);
      }
      if (filterPid && pidv != filterPid) continue;
      char title[256] = {0};
      if (titleRef) CFStringGetCString(titleRef, title, sizeof(title), kCFStringEncodingUTF8);
      printf("window %d pid=%d layer=%d x=%.0f y=%.0f w=%.0f h=%.0f title=%s\n",
             numv, pidv, layerv, bx, by, bw, bh, title);
    }
    CFRelease(list);
    return 0;
  }

  if (!strcmp(cmd, "window-spaces")) {
    if (argc < 3) return 1;
    CFArrayRef windows = u64_array(argc, argv, 2);
    if (!windows) return 1;
    CFArrayRef result = (CFArrayRef)spaces_for_windows(cid, 0x7, windows);
    if (!result) { printf("call failed\n"); CFRelease(windows); return 2; }
    printf("spaces:");
    for (CFIndex i = 0; i < CFArrayGetCount(result); i++) {
      CFNumberRef v = (CFNumberRef)CFArrayGetValueAtIndex(result, i);
      long long n = 0; CFNumberGetValue(v, kCFNumberSInt64Type, &n);
      printf(" %lld", n);
    }
    printf("\n");
    CFRelease(result);
    CFRelease(windows);
    return 0;
  }

  if (!strcmp(cmd, "create-orphan")) {
    if (!space_create || !space_get_type) { printf("SLSSpaceCreate missing\n"); return 2; }
    uint64_t sid = space_create(cid, 0x1, 0);
    if (!sid) { printf("SLSSpaceCreate returned 0\n"); return 2; }
    pump_events();
    int exists = space_in_copy_spaces(cid, sid);
    int managed = space_is_managed(cid, sid);
    int type = space_get_type(cid, sid);
    printf("created space %llu type=%d exists=%d managed=%d\n",
           (unsigned long long)sid, type, exists, managed);
    // An orphan space is still a real created object; success means the object
    // exists. managed=0 is reported honestly — attach is entitlement-gated.
    return exists ? 0 : 2;
  }

  if (!strcmp(cmd, "destroy")) {
    if (argc < 3) return 1;
    uint64_t sid = strtoull(argv[2], NULL, 10);
    if (!sid) return 1;
    if (!space_destroy) { printf("SLSSpaceDestroy missing\n"); return 2; }
    if (space_is_managed(cid, sid)) { printf("refusing to destroy managed space %llu\n", (unsigned long long)sid); return 2; }
    int rc = space_destroy(cid, sid);
    pump_events();
    int gone = !space_in_copy_spaces(cid, sid);
    printf("destroy %llu rc=%d gone=%d\n", (unsigned long long)sid, rc, gone);
    return (rc == 0 && gone) ? 0 : 2;
  }

  if (!strcmp(cmd, "show")) {
    if (argc < 3) return 1;
    CFArrayRef spaces = u64_array(argc, argv, 2);
    if (!spaces) return 1;
    if (!show_spaces) { printf("SLSShowSpaces missing\n"); CFRelease(spaces); return 2; }
    show_spaces(cid, spaces);
    pump_events();
    int ok = 1;
    for (CFIndex i = 0; i < CFArrayGetCount(spaces); i++) {
      CFNumberRef v = (CFNumberRef)CFArrayGetValueAtIndex(spaces, i);
      long long n = 0; CFNumberGetValue(v, kCFNumberSInt64Type, &n);
      int m = space_is_managed(cid, (uint64_t)n);
      printf("show %lld managed=%d\n", n, m);
      if (!m) ok = 0;
    }
    CFRelease(spaces);
    printf("show verified=%d\n", ok);
    return ok ? 0 : 2;
  }

  if (!strcmp(cmd, "set-current") || !strcmp(cmd, "set-current-instant")) {
    if (argc < 3) return 1;
    int instant = !strcmp(cmd, "set-current-instant");
    uint64_t target = strtoull(argv[2], NULL, 10);
    if (!target) return 1;
    if (!set_current || !copy_display_for_space || !get_active_space) { printf("set-current symbols missing\n"); return 2; }
    if (instant && (!disable_update || !reenable_update)) { printf("instant symbols missing\n"); return 2; }
    CFStringRef uuid = copy_display_for_space(cid, target);
    if (!uuid) { printf("no display for space %llu\n", (unsigned long long)target); return 2; }
    // SLSDisableUpdate suppresses the compositor's slide animation: the
    // space change lands in a few ms instead of the ~0.3s animated sweep.
    // Reenable must always run, or every later window update stalls.
    if (instant) disable_update(cid);
    int rc = set_current(cid, uuid, target);
    if (instant) reenable_update(cid);
    CFRelease(uuid);
    pump_events();
    uint64_t now = get_active_space(cid);
    int ok = rc == 0 && now == target;
    printf("set-current%s rc=%d active=%llu verified=%d\n", instant ? "-instant" : "", rc, (unsigned long long)now, ok);
    return ok ? 0 : 2;
  }

  if (argc < 4) return 1;
  uint64_t space = strtoull(argv[2], NULL, 10);
  if (!space) return 1;
  CFArrayRef windows = u64_array(argc, argv, 3);
  if (!windows) return 1;
  int ok = 0;
  if (!strcmp(cmd, "move")) {
    if (!move_windows) { printf("SLSMoveWindowsToManagedSpace missing\n"); CFRelease(windows); return 2; }
    move_windows(cid, windows, space);
    pump_events();
    ok = space_membership_ok(cid, windows, space, 1);
  } else if (!strcmp(cmd, "add")) {
    if (!add_windows) { printf("SLSAddWindowsToSpaces missing\n"); CFRelease(windows); return 2; }
    long long s = (long long)space; CFNumberRef sn = CFNumberCreate(NULL, kCFNumberSInt64Type, &s);
    CFArrayRef sa = CFArrayCreate(NULL, (const void **)&sn, 1, &kCFTypeArrayCallBacks);
    add_windows(cid, windows, sa);
    CFRelease(sa); CFRelease(sn);
    pump_events();
    ok = space_membership_ok(cid, windows, space, 1);
  } else if (!strcmp(cmd, "remove")) {
    if (!remove_windows) { printf("SLSRemoveWindowsFromSpaces missing\n"); CFRelease(windows); return 2; }
    long long s = (long long)space; CFNumberRef sn = CFNumberCreate(NULL, kCFNumberSInt64Type, &s);
    CFArrayRef sa = CFArrayCreate(NULL, (const void **)&sn, 1, &kCFTypeArrayCallBacks);
    remove_windows(cid, windows, sa);
    CFRelease(sa); CFRelease(sn);
    pump_events();
    ok = space_membership_ok(cid, windows, space, 0);
  } else { CFRelease(windows); return 1; }
  CFRelease(windows);
  printf("%s verified=%d\n", cmd, ok);
  return ok ? 0 : 2;
}
