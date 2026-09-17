// space-ctl: managed-Space operations for agent window isolation.
// Read-only subcommands are safe anywhere. Mutating subcommands move exactly
// the window ids given on the command line and nothing else.
//
// Usage:
//   space-ctl list
//   space-ctl windows [--pid <pid>]
//   space-ctl window-spaces <windowId> [<windowId> ...]
//   space-ctl move <spaceId> <windowId> [<windowId> ...]
//   space-ctl add <spaceId> <windowId> [<windowId> ...]
//   space-ctl remove <spaceId> <windowId> [<windowId> ...]
//   space-ctl set-current <displayId> <spaceId>
//
// Exit codes: 0 ok, 1 usage/arg error, 2 call returned an error.
#include <stdio.h>
#include <dlfcn.h>
#include <stdlib.h>
#include <string.h>
#include <CoreFoundation/CoreFoundation.h>

typedef int (*IntVoid)(void);
typedef CFTypeRef (*CopyManaged)(int);
typedef CFTypeRef (*CopySpacesForWindows)(int, int, CFArrayRef);
typedef CFTypeRef (*CopyWindowInfo)(uint32_t, uint32_t);
typedef int (*MoveWindows)(int, int, CFArrayRef);
typedef int (*AddWindows)(int, CFArrayRef, CFArrayRef);
typedef int (*SetCurrent)(int, uint64_t, uint64_t);

static IntVoid cgs_cid;
static CopyManaged copy_managed;
static CopySpacesForWindows spaces_for_windows;
static CopyWindowInfo copy_window_info;
static MoveWindows move_windows;
static AddWindows add_windows;
static AddWindows remove_windows;
static SetCurrent set_current;

static int load(void *sky) {
  cgs_cid = (IntVoid)dlsym(sky, "CGSMainConnectionID");
  copy_managed = (CopyManaged)dlsym(sky, "SLSCopyManagedDisplaySpaces");
  spaces_for_windows = (CopySpacesForWindows)dlsym(sky, "SLSCopySpacesForWindows");
  move_windows = (MoveWindows)dlsym(sky, "SLSMoveWindowsToManagedSpace");
  add_windows = (AddWindows)dlsym(sky, "SLSAddWindowsToSpaces");
  remove_windows = (AddWindows)dlsym(sky, "SLSRemoveWindowsFromSpaces");
  set_current = (SetCurrent)dlsym(sky, "SLSManagedDisplaySetCurrentSpace");
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

int main(int argc, char **argv) {
  setbuf(stdout, NULL);
  if (argc < 2) { printf("usage: space-ctl list|window-spaces|move|add|remove|set-current ...\n"); return 1; }
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
    return 0;
  }

  if (argc < 4) return 1;
  int space = atoi(argv[2]);
  if (space <= 0) return 1;
  CFArrayRef windows = windows_array(argc, argv, 3);
  if (!windows) return 1;
  int rc = -1;
  if (!strcmp(cmd, "move")) rc = move_windows(cid, space, windows);
  else if (!strcmp(cmd, "add")) {
    int s = space; CFNumberRef sn = CFNumberCreate(NULL, kCFNumberIntType, &s);
    CFArrayRef sa = CFArrayCreate(NULL, (const void **)&sn, 1, &kCFTypeArrayCallBacks);
    rc = add_windows(cid, sa, windows);
    CFRelease(sa); CFRelease(sn);
  } else if (!strcmp(cmd, "remove")) {
    int s = space; CFNumberRef sn = CFNumberCreate(NULL, kCFNumberIntType, &s);
    CFArrayRef sa = CFArrayCreate(NULL, (const void **)&sn, 1, &kCFTypeArrayCallBacks);
    rc = remove_windows(cid, sa, windows);
    CFRelease(sa); CFRelease(sn);
  } else if (!strcmp(cmd, "set-current")) {
    uint64_t display = strtoull(argv[2], NULL, 10);
    uint64_t target = strtoull(argv[3], NULL, 10);
    rc = set_current ? set_current(cid, display, target) : -1;
  } else return 1;
  printf("%s rc=%d\n", cmd, rc);
  return rc == 0 ? 0 : 2;
}
