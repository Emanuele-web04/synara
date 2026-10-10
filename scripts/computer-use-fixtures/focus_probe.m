// focus-probe: samples the user's focus state at a fixed rate so a fixture or
// certification run can prove zero focus theft. Read-only: it never posts an
// event, activates an app, or touches another process's state. Output is
// newline-delimited JSON on stdout; analysis lives in
// apps/desktop/src/cuaFixtures/focusProbe.ts.
//
// Usage:
//   focus-probe --duration <seconds> [--hz <rate>] [--label <text>]
//   focus-probe --stdin [--duration <seconds>] [--hz <rate>]
//   focus-probe --once
//
// Options: --hz (default 50, 1-500), --top-win-every <n> (CGWindowList read
// every n-th tick; default 5), --label <text> recorded in the meta line.
//
// --stdin stops sampling when stdin reaches EOF, so a parent holds the pipe
// open for the measured section and closes it to stop. --duration is a hard
// cap in both modes. SIGINT/SIGTERM/SIGHUP stop cleanly.
//
// Exit codes: 0 clean stop, 1 usage error, 2 runtime failure.
//
// Sample line shape (keys absent fields are emitted as null):
//   {"t":<ms since start>,"pid":<frontmost pid>,"app":<frontmost name>,
//    "keyWin":<AX focused window CGWindowID>,"keyTitle":<its title>,
//    "topWin":<topmost layer-0 CGWindowID for front pid>,"topTitle":<title>,
//    "space":<SLSGetActiveSpace id>,"focused":"<pid>:<role>:<title>"}
//
// keyWin/focused need Accessibility trust (AXIsProcessTrusted on this binary);
// topWin/topTitle need nothing, and topTitle additionally needs a screen
// recording grant to carry the real title. space needs the private
// SLSGetActiveSpace symbol. Every field degrades to null independently.
#import <AppKit/AppKit.h>
#import <ApplicationServices/ApplicationServices.h>
#import <CoreGraphics/CoreGraphics.h>
#include <dlfcn.h>
#include <errno.h>
#include <limits.h>
#include <mach/mach_time.h>
#include <poll.h>
#include <signal.h>
#include <stdbool.h>
#include <stdint.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <unistd.h>

typedef void (*SLPSGetFrontProcessFn)(ProcessSerialNumber *psn);
typedef int (*CGSMainConnectionIDFn)(void);
typedef uint64_t (*SLSGetActiveSpaceFn)(int);
// Private HIServices bridge: AXUIElement -> CGWindowID. Resolved dynamically,
// same story as the SkyLight symbols in space_ctl.m.
typedef AXError (*AXUIElementGetWindowFn)(AXUIElementRef element, CGWindowID *windowId);

static volatile sig_atomic_t gSignalStop = 0;
static void onSignal(int signal) { (void)signal; gSignalStop = 1; }

static SLPSGetFrontProcessFn gGetFront;
static SLSGetActiveSpaceFn gGetActiveSpace;
static AXUIElementGetWindowFn gAXWindowId;
static int gConnection = -1;
static mach_timebase_info_data_t gTimebase;

static double monotonicMs(void) {
  return (double)(mach_absolute_time() * gTimebase.numer / gTimebase.denom) / 1e6;
}

static void jsonString(FILE *stream, const char *value) {
  fputc('"', stream);
  for (const unsigned char *cursor = (const unsigned char *)value; *cursor; cursor++) {
    switch (*cursor) {
      case '"': fputs("\\\"", stream); break;
      case '\\': fputs("\\\\", stream); break;
      case '\n': fputs("\\n", stream); break;
      case '\r': fputs("\\r", stream); break;
      case '\t': fputs("\\t", stream); break;
      default:
        if (*cursor < 0x20)
          fprintf(stream, "\\u%04x", *cursor);
        else
          fputc(*cursor, stream);
    }
  }
  fputc('"', stream);
}

static void jsonNumberOrNull(FILE *stream, bool present, long long value) {
  if (present)
    fprintf(stream, "%lld", value);
  else
    fputs("null", stream);
}

static void jsonTextOrNull(FILE *stream, const char *value) {
  if (value)
    jsonString(stream, value);
  else
    fputs("null", stream);
}

static void cfText(CFStringRef string, char *buffer, size_t size) {
  buffer[0] = 0;
  if (string)
    CFStringGetCString(string, buffer, size, kCFStringEncodingUTF8);
}

static pid_t frontmostPid(void) {
  // NSWorkspace's cached frontmost application needs a serviced run loop.
  // This sampler polls synchronously, so prefer the native current reading.
  if (gGetFront) {
    ProcessSerialNumber psn = {0, 0};
    gGetFront(&psn);
    pid_t pid = -1;
    if (GetProcessPID(&psn, &pid) == noErr && pid > 0)
      return pid;
  }
  // Only the fallback needs AppKit's cached observation refreshed.
  CFRunLoopRunInMode(kCFRunLoopDefaultMode, 0, true);
  NSRunningApplication *front = NSWorkspace.sharedWorkspace.frontmostApplication;
  if (front)
    return front.processIdentifier;
  return -1;
}

static void frontmostName(pid_t pid, char *buffer, size_t size) {
  buffer[0] = 0;
  if (pid < 1)
    return;
  NSRunningApplication *app = [NSRunningApplication runningApplicationWithProcessIdentifier:pid];
  NSString *name = app.localizedName ?: app.bundleIdentifier;
  if (name)
    strncpy(buffer, name.UTF8String, size - 1);
}

// One AX round trip for a list of attributes; failed entries come back as
// AXValue-wrapped AXError and are skipped by the string/number readers.
static CFArrayRef copyAttributes(AXUIElementRef element, CFArrayRef attributes) {
  CFArrayRef values = NULL;
  if (AXUIElementCopyMultipleAttributeValues(element, attributes,
                                             (AXCopyMultipleAttributeOptions)0,
                                             &values) != kAXErrorSuccess ||
      !values || CFGetTypeID(values) != CFArrayGetTypeID())
    return NULL;
  return values;
}

static bool attrIsError(CFTypeRef value) {
  return !value || CFGetTypeID(value) != CFStringGetTypeID();
}

// AX focused ("key") window of the frontmost app + the system focused element.
// Both need this process to hold the Accessibility grant. focusedPid is the
// owner of the system-wide focused element: typing focus can move to another
// app (desktop, menu bar, agent target) while frontmostApplication still
// reads the human's app, so it is a first-class theft field.
static void axSample(pid_t frontPid, CGWindowID *keyWindow, char *keyTitle, size_t keyTitleSize,
                     pid_t *focusedPid, char *focused, size_t focusedSize) {
  *keyWindow = kCGNullWindowID;
  *focusedPid = -1;
  keyTitle[0] = 0;
  focused[0] = 0;
  if (!AXIsProcessTrusted())
    return;

  if (frontPid > 0) {
    AXUIElementRef app = AXUIElementCreateApplication(frontPid);
    if (app) {
      CFTypeRef window = NULL;
      if (AXUIElementCopyAttributeValue(app, kAXFocusedWindowAttribute, &window) == kAXErrorSuccess &&
          window && CFGetTypeID(window) == AXUIElementGetTypeID()) {
        if (gAXWindowId) {
          CGWindowID windowId = kCGNullWindowID;
          if (gAXWindowId((AXUIElementRef)window, &windowId) == kAXErrorSuccess)
            *keyWindow = windowId;
        }
        const void *names[] = {kAXTitleAttribute};
        CFArrayRef attributes =
            CFArrayCreate(NULL, names, 1, &kCFTypeArrayCallBacks);
        CFArrayRef values = copyAttributes((AXUIElementRef)window, attributes);
        if (values && CFArrayGetCount(values) == 1) {
          CFTypeRef title = CFArrayGetValueAtIndex(values, 0);
          if (!attrIsError(title))
            cfText((CFStringRef)title, keyTitle, keyTitleSize);
        }
        if (values)
          CFRelease(values);
        CFRelease(attributes);
        CFRelease(window);
      }
      CFRelease(app);
    }
  }

  AXUIElementRef system = AXUIElementCreateSystemWide();
  if (!system)
    return;
  CFTypeRef element = NULL;
  if (AXUIElementCopyAttributeValue(system, kAXFocusedUIElementAttribute, &element) ==
          kAXErrorSuccess &&
      element && CFGetTypeID(element) == AXUIElementGetTypeID()) {
    const void *names[] = {kAXRoleAttribute, kAXTitleAttribute, CFSTR("AXDescription"),
                           kAXIdentifierAttribute, CFSTR("AXPid")};
    CFArrayRef attributes = CFArrayCreate(NULL, names, 5, &kCFTypeArrayCallBacks);
    CFArrayRef values = copyAttributes((AXUIElementRef)element, attributes);
    char role[128] = {0};
    char label[192] = {0};
    if (values && CFArrayGetCount(values) == 5) {
      CFTypeRef roleValue = CFArrayGetValueAtIndex(values, 0);
      if (!attrIsError(roleValue))
        cfText((CFStringRef)roleValue, role, sizeof(role));
      for (CFIndex index = 1; index <= 3; index++) {
        CFTypeRef text = CFArrayGetValueAtIndex(values, index);
        if (!attrIsError(text)) {
          cfText((CFStringRef)text, label, sizeof(label));
          if (label[0])
            break;
        }
      }
      CFTypeRef pidValue = CFArrayGetValueAtIndex(values, 4);
      if (pidValue && CFGetTypeID(pidValue) == CFNumberGetTypeID())
        CFNumberGetValue((CFNumberRef)pidValue, kCFNumberIntType, focusedPid);
    }
    if (values)
      CFRelease(values);
    CFRelease(attributes);
    if (*focusedPid < 1)
      AXUIElementGetPid((AXUIElementRef)element, focusedPid);
    // A compact identity string: the analyzer only needs change detection.
    snprintf(focused, focusedSize, "%d:%s:%s", (int)*focusedPid, role, label);
    CFRelease(element);
  } else if (element) {
    CFRelease(element);
  }
  CFRelease(system);
}

// Topmost normal-layer onscreen window owned by the frontmost process. Needs
// no grant for the id; the title follows the screen-recording grant.
static void topWindowSample(pid_t frontPid, CGWindowID *window, char *title, size_t titleSize) {
  *window = kCGNullWindowID;
  title[0] = 0;
  if (frontPid < 1)
    return;
  CFArrayRef list = CGWindowListCopyWindowInfo(
      kCGWindowListOptionOnScreenOnly | kCGWindowListExcludeDesktopElements, kCGNullWindowID);
  if (!list)
    return;
  CFIndex count = CFArrayGetCount(list);
  for (CFIndex index = 0; index < count; index++) {
    CFDictionaryRef info = (CFDictionaryRef)CFArrayGetValueAtIndex(list, index);
    CFNumberRef owner = (CFNumberRef)CFDictionaryGetValue(info, kCGWindowOwnerPID);
    int ownerPid = 0;
    if (!owner || !CFNumberGetValue(owner, kCFNumberIntType, &ownerPid) || ownerPid != frontPid)
      continue;
    CFNumberRef layer = (CFNumberRef)CFDictionaryGetValue(info, kCGWindowLayer);
    int layerValue = -1;
    if (layer)
      CFNumberGetValue(layer, kCFNumberIntType, &layerValue);
    if (layerValue != 0)
      continue;
    CFNumberRef number = (CFNumberRef)CFDictionaryGetValue(info, kCGWindowNumber);
    int numberValue = 0;
    if (number && CFNumberGetValue(number, kCFNumberSInt32Type, &numberValue))
      *window = (CGWindowID)numberValue;
    cfText((CFStringRef)CFDictionaryGetValue(info, kCGWindowName), title, titleSize);
    break;
  }
  CFRelease(list);
}

static void emitSample(double tMs, bool withTopWindow) {
  pid_t pid = frontmostPid();
  char app[256];
  frontmostName(pid, app, sizeof(app));

  CGWindowID keyWindow = kCGNullWindowID;
  char keyTitle[512];
  pid_t focusedPid = -1;
  char focused[384];
  axSample(pid, &keyWindow, keyTitle, sizeof(keyTitle), &focusedPid, focused, sizeof(focused));

  // CGWindowListCopyWindowInfo costs ~5-10 ms per call, so this field runs on
  // a divisor of the tick rate. An unsampled tick emits null rather than a
  // stale repeat, so the analyzer never mistakes a repeat for a reading.
  CGWindowID topWindow = kCGNullWindowID;
  char topTitle[512];
  topTitle[0] = 0;
  if (withTopWindow)
    topWindowSample(pid, &topWindow, topTitle, sizeof(topTitle));

  bool spaceSet = false;
  uint64_t space = 0;
  if (gGetActiveSpace && gConnection >= 0) {
    space = gGetActiveSpace(gConnection);
    spaceSet = space != 0;
  }

  fprintf(stdout, "{\"t\":%.1f,\"pid\":", tMs);
  jsonNumberOrNull(stdout, pid > 0, pid);
  fputs(",\"app\":", stdout);
  jsonTextOrNull(stdout, app[0] ? app : NULL);
  fputs(",\"keyWin\":", stdout);
  jsonNumberOrNull(stdout, keyWindow != kCGNullWindowID, keyWindow);
  fputs(",\"keyTitle\":", stdout);
  jsonTextOrNull(stdout, keyTitle[0] ? keyTitle : NULL);
  fputs(",\"topWin\":", stdout);
  jsonNumberOrNull(stdout, topWindow != kCGNullWindowID, topWindow);
  fputs(",\"topTitle\":", stdout);
  jsonTextOrNull(stdout, topTitle[0] ? topTitle : NULL);
  fputs(",\"space\":", stdout);
  jsonNumberOrNull(stdout, spaceSet, (long long)space);
  fputs(",\"focusedPid\":", stdout);
  jsonNumberOrNull(stdout, focusedPid > 0, focusedPid);
  fputs(",\"focused\":", stdout);
  jsonTextOrNull(stdout, focused[0] ? focused : NULL);
  fputs("}\n", stdout);
}

static bool stdinClosed(void) {
  struct pollfd descriptor = {.fd = STDIN_FILENO, .events = POLLIN | POLLHUP};
  if (poll(&descriptor, 1, 0) <= 0)
    return false;
  if (!(descriptor.revents & (POLLIN | POLLHUP | POLLERR)))
    return false;
  char buffer[256];
  ssize_t count = read(STDIN_FILENO, buffer, sizeof(buffer));
  if (count == 0)
    return true;
  if (count < 0 && errno != EAGAIN && errno != EWOULDBLOCK && errno != EINTR)
    return true;
  return false;
}

// nanosleep/usleep/mach_wait_until all overshoot badly under macOS timer
// coalescing on this class of process (measured: 40-80% over the ask). poll()
// wakes within ~5% and a short spin closes the rest, so the tick cadence the
// report advertises is the cadence samples actually ran at.
static void waitUntil(double deadlineMs, double startEpochMs, uint64_t startTicks) {
  double remainingMs = deadlineMs - monotonicMs();
  if (remainingMs <= 0)
    return;
  // deadlineMs is on the monotonicMs() scale whose zero is startEpochMs;
  // convert the *delta* to mach ticks or the deadline lands eons out.
  uint64_t deadline = startTicks + (uint64_t)((deadlineMs - startEpochMs) * 1e6 *
                                            (double)gTimebase.denom / (double)gTimebase.numer);
  if (remainingMs > 3.0)
    poll(NULL, 0, (int)(remainingMs - 1.5));
  while (mach_absolute_time() < deadline) {
  }
}

static bool parseDouble(const char *text, double minimum, double maximum, double *value) {
  char *end = NULL;
  errno = 0;
  double parsed = strtod(text, &end);
  if (errno == ERANGE || end == text || *end != '\0' || parsed < minimum || parsed > maximum)
    return false;
  *value = parsed;
  return true;
}

int main(int argc, char **argv) {
  @autoreleasepool {
    double hz = 50.0;
    double durationSeconds = 0;
    bool durationSet = false;
    bool watchStdin = false;
    bool once = false;
    long topWinEvery = 5;
    const char *label = NULL;

    for (int index = 1; index < argc; index++) {
      const char *argument = argv[index];
      if (!strcmp(argument, "--stdin")) {
        watchStdin = true;
        continue;
      }
      if (!strcmp(argument, "--once")) {
        once = true;
        continue;
      }
      if (!strcmp(argument, "--hz") || !strcmp(argument, "--duration") ||
          !strcmp(argument, "--label") || !strcmp(argument, "--top-win-every")) {
        if (index + 1 >= argc) {
          fprintf(stderr, "focus-probe: %s needs a value\n", argument);
          return 1;
        }
        const char *value = argv[++index];
        if (!strcmp(argument, "--hz")) {
          if (!parseDouble(value, 1, 500, &hz)) {
            fprintf(stderr, "focus-probe: invalid --hz: %s\n", value);
            return 1;
          }
        } else if (!strcmp(argument, "--duration")) {
          if (!parseDouble(value, 0.05, 86400, &durationSeconds)) {
            fprintf(stderr, "focus-probe: invalid --duration: %s\n", value);
            return 1;
          }
          durationSet = true;
        } else if (!strcmp(argument, "--top-win-every")) {
          double parsed;
          if (!parseDouble(value, 1, 10000, &parsed)) {
            fprintf(stderr, "focus-probe: invalid --top-win-every: %s\n", value);
            return 1;
          }
          topWinEvery = (long)parsed;
        } else {
          label = value;
        }
        continue;
      }
      fprintf(stderr, "focus-probe: unknown argument: %s\n", argument);
      return 1;
    }
    if (!once && !watchStdin && !durationSet) {
      fprintf(stderr, "focus-probe: pass --duration, --stdin, or --once\n");
      return 1;
    }

    mach_timebase_info(&gTimebase);
    signal(SIGINT, onSignal);
    signal(SIGTERM, onSignal);
    signal(SIGHUP, onSignal);

    void *appServices = dlopen(
        "/System/Library/Frameworks/ApplicationServices.framework/ApplicationServices",
        RTLD_NOW | RTLD_GLOBAL);
    gGetFront = (SLPSGetFrontProcessFn)dlsym(RTLD_DEFAULT, "_SLPSGetFrontProcess");
    gAXWindowId = (AXUIElementGetWindowFn)dlsym(RTLD_DEFAULT, "_AXUIElementGetWindow");
    if (!gAXWindowId && appServices)
      gAXWindowId = (AXUIElementGetWindowFn)dlsym(appServices, "_AXUIElementGetWindow");

    void *sky = dlopen("/System/Library/PrivateFrameworks/SkyLight.framework/SkyLight",
                       RTLD_NOW | RTLD_GLOBAL);
    CGSMainConnectionIDFn connectionId = NULL;
    if (sky) {
      connectionId = (CGSMainConnectionIDFn)dlsym(sky, "CGSMainConnectionID");
      gGetActiveSpace = (SLSGetActiveSpaceFn)dlsym(sky, "SLSGetActiveSpace");
    }
    if (connectionId)
      gConnection = connectionId();

    setbuf(stdout, NULL);
    bool axTrusted = AXIsProcessTrusted();
    fprintf(stdout, "{\"kind\":\"meta\",\"pid\":%d,\"hz\":%.2f,\"topWinEvery\":%ld,"
                    "\"axTrusted\":%s,\"axWindowSymbol\":%s,\"slsSpace\":%s,"
                    "\"stdinWatch\":%s,\"label\":",
            getpid(), hz, topWinEvery, axTrusted ? "true" : "false",
            gAXWindowId ? "true" : "false",
            (gGetActiveSpace && gConnection >= 0) ? "true" : "false",
            watchStdin ? "true" : "false");
    jsonTextOrNull(stdout, label);
    fprintf(stdout, ",\"startedAt\":%.3f}\n",
            [[NSDate date] timeIntervalSince1970]);

    const double periodMs = 1000.0 / hz;
    const double durationMs = durationSeconds * 1000.0;
    const double started = monotonicMs();
    const uint64_t startTicks = mach_absolute_time();
    unsigned long long samples = 0;
    unsigned long long overruns = 0;
    double sampleMsTotal = 0;
    double sampleMsMax = 0;
    const char *stoppedBy = "duration";

    for (uint64_t tick = 0;; tick++) {
      const double now = monotonicMs();
      const double elapsed = now - started;
      if (durationSet && elapsed >= durationMs)
        break;
      if (gSignalStop) {
        stoppedBy = "signal";
        break;
      }
      if (watchStdin && stdinClosed()) {
        stoppedBy = "stdin";
        break;
      }
      @autoreleasepool {
        emitSample(elapsed, tick % (uint64_t)topWinEvery == 0);
      }
      samples++;
      const double emitMs = monotonicMs() - now;
      sampleMsTotal += emitMs;
      if (emitMs > sampleMsMax)
        sampleMsMax = emitMs;
      if (once) {
        stoppedBy = "once";
        break;
      }
      const double next = started + (double)(tick + 1) * periodMs;
      if (next - monotonicMs() < -periodMs)
        overruns++;
      else
        waitUntil(next, started, startTicks);
    }

    fprintf(stdout,
            "{\"kind\":\"done\",\"samples\":%llu,\"elapsedMs\":%.1f,\"overruns\":%llu,"
            "\"sampleMsAvg\":%.2f,\"sampleMsMax\":%.2f,\"stoppedBy\":",
            samples, monotonicMs() - started, overruns,
            samples ? sampleMsTotal / (double)samples : 0.0, sampleMsMax);
    jsonString(stdout, stoppedBy);
    fputs("}\n", stdout);
    return 0;
  }
}
