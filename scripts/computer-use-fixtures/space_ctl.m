// space-ctl: managed-Space operations for agent window isolation.
// Read-only subcommands are safe anywhere. Mutating subcommands move exactly
// the window ids given on the command line and nothing else.
//
// Usage:
//   space-ctl list
//   space-ctl active-space
//   space-ctl windows [--pid <pid>]
//   space-ctl window-spaces <windowId> [<windowId> ...]
//   space-ctl move <spaceId> <windowId> [<windowId> ...]
//   space-ctl add <spaceId> <windowId> [<windowId> ...]
//   space-ctl remove <spaceId> <windowId> [<windowId> ...]
//   space-ctl set-current <spaceId>
//
// Exit codes: 0 ok, 1 usage/arg error, 2 call returned an error or the
// post-call read-back did not confirm the requested membership.
//
// Note: on SIP-enabled macOS 15+, move/add/remove are silent no-ops for
// windows owned by other processes (SkyLight rejects them). The read-back
// check makes that refusal visible instead of trusting a return code.
#include <stdio.h>
#include <dlfcn.h>
#include <stdlib.h>
#include <string.h>
#include <CoreFoundation/CoreFoundation.h>

typedef int (*IntVoid)(void);
typedef CFTypeRef (*CopyManaged)(int);
typedef CFTypeRef (*CopySpacesForWindows)(int, int, CFArrayRef);
typedef CFTypeRef (*CopyWindowInfo)(uint32_t, uint32_t);
typedef void (*MoveWindows)(int, CFArrayRef, uint64_t);
typedef void (*AddWindows)(int, CFArrayRef, CFArrayRef);
typedef int (*SetCurrent)(int, CFStringRef, uint64_t);
typedef uint64_t (*GetActiveSpace)(int);
typedef CFStringRef (*CopyDisplayForSpace)(int, uint64_t);

static IntVoid cgs_cid;
static CopyManaged copy_managed;
static CopySpacesForWindows spaces_for_windows;
static CopyWindowInfo copy_window_info;
static MoveWindows move_windows;
static AddWindows add_windows;
static AddWindows remove_windows;
static SetCurrent set_current;
static GetActiveSpace get_active_space;
static CopyDisplayForSpace copy_display_for_space;

static int load(void *sky) {
  cgs_cid = (IntVoid)dlsym(sky, "CGSMainConnectionID");
  copy_managed = (CopyManaged)dlsym(sky, "SLSCopyManagedDisplaySpaces");
  spaces_for_windows = (CopySpacesForWindows)dlsym(sky, "SLSCopySpacesForWindows");
  move_windows = (MoveWindows)dlsym(sky, "SLSMoveWindowsToManagedSpace");
  add_windows = (AddWindows)dlsym(sky, "SLSAddWindowsToSpaces");
  remove_windows = (AddWindows)dlsym(sky, "SLSRemoveWindowsFromSpaces");
  set_current = (SetCurrent)dlsym(sky, "SLSManagedDisplaySetCurrentSpace");
  get_active_space = (GetActiveSpace)dlsym(sky, "SLSGetActiveSpace");
  copy_display_for_space = (CopyDisplayForSpace)dlsym(sky, "SLSCopyManagedDisplayForSpace");
  copy_window_info = (CopyWindowInfo)dlsym(RTLD_DEFAULT, "CGWindowListCopyWindowInfo");
  return cgs_cid && copy_managed && spaces_for_windows;
}

static CFArrayRef windows_array(int argc, char **argv, int from) {
  CFMutableArrayRef windows = CFArrayCreateMutable(NULL, 0, &kCFTypeArrayCallBacks);
  for (int i = from; i < argc; i++) {
    int wid = atoi(argv[i]);
    if (wid <= 0) { CFRelease(windows); return NULL; }
    CFNumberRef n = CFNumberCreate(NULL, kCFNumberIntType, &wid);
    CFArrayAppendValue(windows, n);
    CFRelease(n);
  }
  return windows;
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

int main(int argc, char **argv) {
  setbuf(stdout, NULL);
  if (argc < 2) { printf("usage: space-ctl list|active-space|window-spaces|move|add|remove|set-current ...\n"); return 1; }
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
        int sidv = -1, tv = -1;
        if (sid) CFNumberGetValue(sid, kCFNumberIntType, &sidv);
        if (type) CFNumberGetValue(type, kCFNumberIntType, &tv);
        printf("  space %d type=%d\n", sidv, tv);
      }
    }
    CFRelease(displays);
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
      if (filterPid && pidv != filterPid) continue;
      char title[256] = {0};
      if (titleRef) CFStringGetCString(titleRef, title, sizeof(title), kCFStringEncodingUTF8);
      printf("window %d pid=%d title=%s\n", numv, pidv, title);
    }
    CFRelease(list);
    return 0;
  }

  if (!strcmp(cmd, "window-spaces")) {
    if (argc < 3) return 1;
    CFArrayRef windows = windows_array(argc, argv, 2);
    if (!windows) return 1;
    CFArrayRef result = (CFArrayRef)spaces_for_windows(cid, 0x7, windows);
    if (!result) { printf("call failed\n"); return 2; }
    printf("spaces:");
    for (CFIndex i = 0; i < CFArrayGetCount(result); i++) {
      CFNumberRef v = (CFNumberRef)CFArrayGetValueAtIndex(result, i);
      long n = 0; CFNumberGetValue(v, kCFNumberLongType, &n);
      printf(" %ld", n);
    }
    printf("\n");
    CFRelease(result);
    return 0;
  }

  if (!strcmp(cmd, "set-current")) {
    if (argc < 3) return 1;
    uint64_t target = strtoull(argv[2], NULL, 10);
    if (!target) return 1;
    if (!set_current || !copy_display_for_space) { printf("set-current symbols missing\n"); return 2; }
    CFStringRef uuid = copy_display_for_space(cid, target);
    if (!uuid) { printf("no display for space %llu\n", (unsigned long long)target); return 2; }
    int rc = set_current(cid, uuid, target);
    CFRelease(uuid);
    printf("set-current rc=%d\n", rc);
    return rc == 0 ? 0 : 2;
  }

  if (argc < 4) return 1;
  uint64_t space = strtoull(argv[2], NULL, 10);
  if (!space) return 1;
  CFArrayRef windows = windows_array(argc, argv, 3);
  if (!windows) return 1;
  int ok = 0;
  if (!strcmp(cmd, "move")) {
    if (!move_windows) { printf("SLSMoveWindowsToManagedSpace missing\n"); return 2; }
    move_windows(cid, windows, space);
    ok = space_membership_ok(cid, windows, space, 1);
  } else if (!strcmp(cmd, "add")) {
    if (!add_windows) { printf("SLSAddWindowsToSpaces missing\n"); return 2; }
    long long s = (long long)space; CFNumberRef sn = CFNumberCreate(NULL, kCFNumberSInt64Type, &s);
    CFArrayRef sa = CFArrayCreate(NULL, (const void **)&sn, 1, &kCFTypeArrayCallBacks);
    add_windows(cid, windows, sa);
    CFRelease(sa); CFRelease(sn);
    ok = space_membership_ok(cid, windows, space, 1);
  } else if (!strcmp(cmd, "remove")) {
    if (!remove_windows) { printf("SLSRemoveWindowsFromSpaces missing\n"); return 2; }
    long long s = (long long)space; CFNumberRef sn = CFNumberCreate(NULL, kCFNumberSInt64Type, &s);
    CFArrayRef sa = CFArrayCreate(NULL, (const void **)&sn, 1, &kCFTypeArrayCallBacks);
    remove_windows(cid, windows, sa);
    CFRelease(sa); CFRelease(sn);
    ok = space_membership_ok(cid, windows, space, 0);
  } else return 1;
  printf("%s verified=%d\n", cmd, ok);
  return ok ? 0 : 2;
}
