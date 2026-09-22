// display-ctl: display enumeration and focus sampling for multi-display
// computer-use certification on macOS. Read-only: it never posts an event,
// moves a window, or touches another process's state.
//
// Usage:
//   display-ctl list                      one line per display plus its Spaces
//   display-ctl json                      one JSON document on stdout (same data)
//   display-ctl count                     active display count only
//   display-ctl front                     frontmost pid + app name (no grant)
//   display-ctl window-display <wid>...   owning display UUID per CGWindowID
//
// Exit codes: 0 ok, 1 usage/arg error, 2 a required API failed.
//
// Display identity: the stable per-hardware UUID that SLSCopyManagedDisplay-
// Spaces keys its "Display Identifier" on, resolved through SkyLight's
// CGSCopyBestManagedDisplayForRect — the same call yabai uses — which survives
// disconnect/reconnect where the CGDirectDisplayID does not. Older builds
// answer through the public CGDisplayCreateUUID first when it is still
// exported; when neither resolves a synthetic "display-<id>" is emitted and
// `stable` reads false, so a report never confuses a session id with hardware
// identity.
//
// Geometry: CGDisplayBounds is the global point space CGWindowList's
// kCGWindowBounds reports — a window's display is decided by bounds
// intersection — and `window-display` gives the WindowServer's own
// authoritative answer (CGSCopyManagedDisplayForWindow) so the two can be
// cross-checked in a cert report.
//
// Scale: two independent readings — the current display mode's pixel/point
// ratio (pure CoreGraphics) and NSScreen.backingScaleFactor. Per-display
// Spaces come from SLSCopyManagedDisplaySpaces plus
// CGSManagedDisplayGetCurrentSpace as a second current-Space source; when
// SkyLight is absent the space fields degrade to null rather than failing the
// enumeration.
#import <AppKit/AppKit.h>
#import <CoreFoundation/CoreFoundation.h>
#import <CoreGraphics/CoreGraphics.h>
#include <dlfcn.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>

typedef int (*IntVoid)(void);
typedef CFTypeRef (*CopyManaged)(int);
typedef CFStringRef (*BestForRect)(int, CGRect);
typedef unsigned long long (*CurrentSpace)(int, CFStringRef);
typedef CFStringRef (*DisplayForWindow)(int, unsigned int);
typedef CFUUIDRef (*CreateDisplayUUID)(CGDirectDisplayID);

static IntVoid g_cid_fn;
static CopyManaged g_copy_managed;
static BestForRect g_best_for_rect;
static CurrentSpace g_current_space;
static DisplayForWindow g_display_for_window;
static CreateDisplayUUID g_create_display_uuid;
static int g_cid = -1;
static int g_sky_tried = 0;
static int g_sky_ok = 0;

// Resolve the SkyLight bridge once; failure is sticky for the process.
static int sky(void) {
  if (g_sky_tried) return g_sky_ok;
  g_sky_tried = 1;
  void *handle = dlopen("/System/Library/PrivateFrameworks/SkyLight.framework/SkyLight",
                        RTLD_NOW | RTLD_GLOBAL);
  if (!handle) return 0;
  g_cid_fn = (IntVoid)dlsym(handle, "CGSMainConnectionID");
  g_copy_managed = (CopyManaged)dlsym(handle, "SLSCopyManagedDisplaySpaces");
  g_best_for_rect = (BestForRect)dlsym(handle, "CGSCopyBestManagedDisplayForRect");
  if (!g_best_for_rect)
    g_best_for_rect = (BestForRect)dlsym(handle, "SLSCopyBestManagedDisplayForRect");
  g_current_space = (CurrentSpace)dlsym(handle, "CGSManagedDisplayGetCurrentSpace");
  g_display_for_window = (DisplayForWindow)dlsym(handle, "CGSCopyManagedDisplayForWindow");
  g_create_display_uuid =
      (CreateDisplayUUID)dlsym(RTLD_DEFAULT, "CGDisplayCreateUUID");
  g_sky_ok = g_cid_fn != NULL;
  if (g_sky_ok) g_cid = g_cid_fn();
  return g_sky_ok;
}

static void cf_text(CFStringRef string, char *buffer, size_t size) {
  buffer[0] = 0;
  if (string)
    CFStringGetCString(string, buffer, size, kCFStringEncodingUTF8);
}

static void json_string(const char *value) {
  putchar('"');
  if (value)
    for (const unsigned char *cursor = (const unsigned char *)value; *cursor; cursor++) {
      switch (*cursor) {
        case '"': fputs("\\\"", stdout); break;
        case '\\': fputs("\\\\", stdout); break;
        case '\n': fputs("\\n", stdout); break;
        case '\r': fputs("\\r", stdout); break;
        case '\t': fputs("\\t", stdout); break;
        default:
          if (*cursor < 0x20)
            fprintf(stdout, "\\u%04x", *cursor);
          else
            putchar(*cursor);
      }
    }
  putchar('"');
}

// The stable hardware UUID for a rect, or NULL. CGSCopyBestManagedDisplayForRect
// answers the UUID string SLSCopyManagedDisplaySpaces reports; a CFUUIDRef return
// on an older build is handled the same way.
static void display_uuid(CGRect rect, CGDirectDisplayID fallbackId, char *out, size_t size,
                         int *stable) {
  out[0] = 0;
  *stable = 0;
  if (sky() && g_best_for_rect) {
    CFTypeRef value = (CFTypeRef)g_best_for_rect(g_cid, rect);
    if (value) {
      if (CFGetTypeID(value) == CFStringGetTypeID()) {
        cf_text((CFStringRef)value, out, size);
      } else if (CFGetTypeID(value) == CFUUIDGetTypeID()) {
        CFStringRef string = CFUUIDCreateString(NULL, (CFUUIDRef)value);
        if (string) {
          cf_text(string, out, size);
          CFRelease(string);
        }
      }
      CFRelease(value);
    }
  }
  if (!out[0] && g_create_display_uuid) {
    CFUUIDRef uuid = g_create_display_uuid(fallbackId);
    if (uuid) {
      CFStringRef string = CFUUIDCreateString(NULL, uuid);
      if (string) {
        cf_text(string, out, size);
        CFRelease(string);
      }
      CFRelease(uuid);
    }
  }
  if (out[0]) {
    *stable = 1;
    return;
  }
  snprintf(out, size, "display-%u", fallbackId);
}

typedef struct {
  CGDirectDisplayID id;
  char uuid[64];
  int uuidStable;
  CGRect bounds;
  double modeScale;   // CGDisplayMode pixel/point ratio; 0 when unreadable
  double screenScale; // NSScreen backingScaleFactor; 0 when AppKit had no match
  int main;
  int builtin;
  int online;
  int active;
} DisplayInfo;

// NSScreen.screens keyed by the NSScreenNumber device-description entry,
// which is the CGDirectDisplayID. Absent entries (headless, AppKit without a
// window-server connection) leave screenScale at 0 — the CoreGraphics mode
// ratio still answers.
static void fill_screen_scales(DisplayInfo *displays, uint32_t count) {
  @autoreleasepool {
    for (NSScreen *screen in NSScreen.screens) {
      NSNumber *number = screen.deviceDescription[@"NSScreenNumber"];
      if (![number respondsToSelector:@selector(unsignedIntValue)]) continue;
      CGDirectDisplayID id = (CGDirectDisplayID)[number unsignedIntValue];
      for (uint32_t i = 0; i < count; i++)
        if (displays[i].id == id) displays[i].screenScale = screen.backingScaleFactor;
    }
  }
}

static int enumerate_displays(DisplayInfo *out, uint32_t capacity) {
  uint32_t count = 0;
  if (CGGetActiveDisplayList(0, NULL, &count) != kCGErrorSuccess || count == 0) return -1;
  CGDirectDisplayID *ids = malloc(sizeof(CGDirectDisplayID) * count);
  if (!ids) return -1;
  if (CGGetActiveDisplayList(count, ids, &count) != kCGErrorSuccess) {
    free(ids);
    return -1;
  }
  uint32_t emitted = count < capacity ? count : capacity;
  for (uint32_t i = 0; i < emitted; i++) {
    DisplayInfo *d = &out[i];
    memset(d, 0, sizeof(*d));
    d->id = ids[i];
    d->bounds = CGDisplayBounds(ids[i]);
    d->main = CGDisplayIsMain(ids[i]);
    d->builtin = CGDisplayIsBuiltin(ids[i]);
    d->online = CGDisplayIsOnline(ids[i]);
    d->active = CGDisplayIsActive(ids[i]);
    display_uuid(d->bounds, ids[i], d->uuid, sizeof(d->uuid), &d->uuidStable);
    CGDisplayModeRef mode = CGDisplayCopyDisplayMode(ids[i]);
    if (mode) {
      size_t points = CGDisplayModeGetWidth(mode);
      size_t pixels = CGDisplayModeGetPixelWidth(mode);
      if (points > 0) d->modeScale = (double)pixels / (double)points;
      CFRelease(mode);
    }
  }
  free(ids);
  fill_screen_scales(out, emitted);
  return (int)emitted;
}

typedef struct {
  char uuid[64];
  long long currentSpace;    // the dict's "Current Space".ManagedSpaceID
  long long currentSpaceAlt; // CGSManagedDisplayGetCurrentSpace cross-check
  long long spaceIds[64];
  int spaceTypes[64];
  int spaceCount;
} DisplaySpaces;

static int str_ieq(const char *a, const char *b) {
  while (*a && *b) {
    char ca = *a, cb = *b;
    if (ca >= 'a' && ca <= 'z') ca -= 'a' - 'A';
    if (cb >= 'a' && cb <= 'z') cb -= 'a' - 'A';
    if (ca != cb) return 0;
    a++;
    b++;
  }
  return *a == *b;
}

static long long dict_int(CFDictionaryRef dict, CFStringRef key, long long fallback) {
  if (!dict) return fallback;
  CFNumberRef value = (CFNumberRef)CFDictionaryGetValue(dict, key);
  long long out = fallback;
  if (value) CFNumberGetValue(value, kCFNumberSInt64Type, &out);
  return out;
}

// SLSCopyManagedDisplaySpaces -> [{Display Identifier, Spaces:[{ManagedSpaceID,
// type,...}], Current Space:{ManagedSpaceID,...}}], matched to CG displays by
// UUID. Returns the number of display entries parsed; -1 when SkyLight or the
// call is unavailable so callers can print spaces:null rather than a lie.
static int read_display_spaces(DisplaySpaces *out, int capacity) {
  if (!sky() || !g_copy_managed) return -1;
  CFArrayRef displays = (CFArrayRef)g_copy_managed(g_cid);
  if (!displays) return -1;
  int count = 0;
  for (CFIndex i = 0; i < CFArrayGetCount(displays) && count < capacity; i++) {
    CFDictionaryRef d = (CFDictionaryRef)CFArrayGetValueAtIndex(displays, i);
    DisplaySpaces *slot = &out[count];
    memset(slot, 0, sizeof(*slot));
    slot->currentSpace = -1;
    slot->currentSpaceAlt = -1;
    CFStringRef name = (CFStringRef)CFDictionaryGetValue(d, CFSTR("Display Identifier"));
    cf_text(name, slot->uuid, sizeof(slot->uuid));
    CFDictionaryRef current =
        (CFDictionaryRef)CFDictionaryGetValue(d, CFSTR("Current Space"));
    if (current) slot->currentSpace = dict_int(current, CFSTR("ManagedSpaceID"), -1);
    if (g_current_space && name) slot->currentSpaceAlt = (long long)g_current_space(g_cid, name);
    CFArrayRef spaces = (CFArrayRef)CFDictionaryGetValue(d, CFSTR("Spaces"));
    if (spaces) {
      for (CFIndex j = 0; j < CFArrayGetCount(spaces) && slot->spaceCount < 64; j++) {
        CFDictionaryRef s = (CFDictionaryRef)CFArrayGetValueAtIndex(spaces, j);
        slot->spaceIds[slot->spaceCount] = dict_int(s, CFSTR("ManagedSpaceID"), -1);
        slot->spaceTypes[slot->spaceCount] = (int)dict_int(s, CFSTR("type"), -1);
        slot->spaceCount++;
      }
    }
    count++;
  }
  CFRelease(displays);
  return count;
}

static DisplaySpaces *spaces_for_uuid(DisplaySpaces *all, int count, const char *uuid) {
  for (int i = 0; i < count; i++)
    if (str_ieq(all[i].uuid, uuid)) return &all[i];
  return NULL;
}

static void print_spaces_lines(DisplaySpaces *spaces) {
  for (int i = 0; i < spaces->spaceCount; i++)
    printf("  space %lld type=%d current=%d\n", spaces->spaceIds[i], spaces->spaceTypes[i],
           spaces->spaceIds[i] == spaces->currentSpace ? 1 : 0);
  if (spaces->currentSpaceAlt >= 0 && spaces->currentSpaceAlt != spaces->currentSpace)
    printf("  current-space-alt %lld (dict said %lld)\n", spaces->currentSpaceAlt,
           spaces->currentSpace);
}

static void print_spaces_json(DisplaySpaces *spaces) {
  if (!spaces) {
    fputs("null", stdout);
    return;
  }
  fputs("{\"currentSpaceId\":", stdout);
  if (spaces->currentSpace >= 0)
    printf("%lld", spaces->currentSpace);
  else
    fputs("null", stdout);
  fputs(",\"currentSpaceIdAlt\":", stdout);
  if (spaces->currentSpaceAlt >= 0)
    printf("%lld", spaces->currentSpaceAlt);
  else
    fputs("null", stdout);
  fputs(",\"spaces\":[", stdout);
  for (int i = 0; i < spaces->spaceCount; i++) {
    if (i) putchar(',');
    printf("{\"id\":%lld,\"type\":%d,\"current\":%s}", spaces->spaceIds[i], spaces->spaceTypes[i],
           spaces->spaceIds[i] == spaces->currentSpace ? "true" : "false");
  }
  fputs("]}", stdout);
}

int main(int argc, char **argv) {
  setbuf(stdout, NULL);
  if (argc < 2) {
    printf("usage: display-ctl list|json|count|front|window-display <wid>...\n");
    return 1;
  }
  const char *cmd = argv[1];

  if (!strcmp(cmd, "front")) {
    @autoreleasepool {
      NSRunningApplication *front = NSWorkspace.sharedWorkspace.frontmostApplication;
      if (!front) {
        printf("front pid=-1 name=(none)\n");
        return 2;
      }
      printf("front pid=%d name=%s\n", front.processIdentifier,
             front.localizedName ? front.localizedName.UTF8String : "(unnamed)");
      return 0;
    }
  }

  if (!strcmp(cmd, "window-display")) {
    if (argc < 3) return 1;
    if (!sky() || !g_display_for_window) {
      printf("CGSCopyManagedDisplayForWindow unavailable\n");
      return 2;
    }
    int ok = 1;
    for (int i = 2; i < argc; i++) {
      unsigned int wid = (unsigned int)strtoul(argv[i], NULL, 10);
      if (!wid) return 1;
      CFStringRef uuid = g_display_for_window(g_cid, wid);
      char buf[128] = {0};
      if (uuid) {
        cf_text(uuid, buf, sizeof(buf));
        CFRelease(uuid);
      }
      printf("window %u display=%s\n", wid, buf[0] ? buf : "(none)");
      if (!buf[0]) ok = 0;
    }
    return ok ? 0 : 2;
  }

  DisplayInfo displays[32];
  int count = enumerate_displays(displays, 32);
  if (count < 0) {
    printf("CGGetActiveDisplayList failed\n");
    return 2;
  }

  if (!strcmp(cmd, "count")) {
    printf("%d\n", count);
    return 0;
  }

  DisplaySpaces spaces[32];
  int spaceCount = read_display_spaces(spaces, 32);

  if (!strcmp(cmd, "list")) {
    for (int i = 0; i < count; i++) {
      DisplayInfo *d = &displays[i];
      printf("display %d id=%u uuid=%s stable=%d bounds=%.0f,%.0f %.0fx%.0f scale=%.3g "
             "screenScale=%.3g main=%d builtin=%d online=%d active=%d\n",
             i, d->id, d->uuid[0] ? d->uuid : "(none)", d->uuidStable, d->bounds.origin.x,
             d->bounds.origin.y, d->bounds.size.width, d->bounds.size.height, d->modeScale,
             d->screenScale, d->main, d->builtin, d->online, d->active);
      DisplaySpaces *s = spaceCount > 0 ? spaces_for_uuid(spaces, spaceCount, d->uuid) : NULL;
      if (s)
        print_spaces_lines(s);
      else
        printf("  spaces %s\n", spaceCount > 0 ? "none-attached" : "unavailable");
    }
    return 0;
  }

  if (!strcmp(cmd, "json")) {
    fputs("{\"displayCount\":", stdout);
    printf("%d", count);
    fputs(",\"displays\":[", stdout);
    for (int i = 0; i < count; i++) {
      DisplayInfo *d = &displays[i];
      if (i) putchar(',');
      printf("{\"index\":%d,\"id\":%u,\"uuid\":", i, d->id);
      json_string(d->uuid[0] ? d->uuid : NULL);
      printf(",\"uuidStable\":%s", d->uuidStable ? "true" : "false");
      printf(",\"bounds\":{\"x\":%.17g,\"y\":%.17g,\"width\":%.17g,\"height\":%.17g}",
             d->bounds.origin.x, d->bounds.origin.y, d->bounds.size.width, d->bounds.size.height);
      printf(",\"modeScale\":");
      if (d->modeScale > 0) printf("%.17g", d->modeScale); else fputs("null", stdout);
      printf(",\"backingScaleFactor\":");
      if (d->screenScale > 0) printf("%.17g", d->screenScale); else fputs("null", stdout);
      printf(",\"main\":%s,\"builtin\":%s,\"online\":%s,\"active\":%s,",
             d->main ? "true" : "false", d->builtin ? "true" : "false",
             d->online ? "true" : "false", d->active ? "true" : "false");
      fputs("\"spaceInfo\":", stdout);
      print_spaces_json(spaceCount > 0 ? spaces_for_uuid(spaces, spaceCount, d->uuid) : NULL);
      fputs("}", stdout);
    }
    fputs("]}\n", stdout);
    return 0;
  }

  printf("usage: display-ctl list|json|count|front|window-display <wid>...\n");
  return 1;
}
