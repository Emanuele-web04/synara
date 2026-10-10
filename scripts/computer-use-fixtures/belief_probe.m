#import <AppKit/AppKit.h>
#import <ApplicationServices/ApplicationServices.h>
#import <CoreGraphics/CoreGraphics.h>
#include <dlfcn.h>
#include <errno.h>
#include <limits.h>
#include <signal.h>
#include <stdbool.h>
#include <stdint.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <stdarg.h>
#include <unistd.h>

// These private event values are the canary's exact candidate phases.
static const NSEventType kAppKitDefinedType = 13; // AppKit-defined event.
static const NSEventType kProcessNotificationType = 21; // CPS process notification.
static const NSEventModifierFlags kActivationModifierFlags = 0xC0000; // Activation flags.
static const short kAppKitDeactivateSubtype = 2; // Application deactivated.
static const short kAppKitActivateSubtype = 1; // Application activated.
static const short kCpsTakenSubtype = 0x4000; // kCPSNotifyKeyFocusTaken.
static const short kCpsChangedSubtype = 0xF102; // kCPSNotifyKeyFocusChanged.
static const short kCpsNewFrontSubtype = 0x0002; // kCPSNotifyNewFront.
static const uint32_t kFocusRecordLength = 248; // Window-manager record size.
static const uint32_t kFocusRecordWindowOffset = 0x3C; // Little-endian window id.
static const uint32_t kFocusRecordMarker = 0xF8; // Focus record marker.
static const uint32_t kFocusRecordKind = 0x0D; // Focus record kind.
static const uint32_t kFocusRecordActive = 0x01; // Active flag.

typedef void (*SLPSGetFrontProcessFn)(ProcessSerialNumber *psn);
typedef void (*SLPSSetFrontProcessWithOptionsFn)(
  ProcessSerialNumber *psn,
  uint32_t windowNumber,
  uint32_t options
);
typedef void (*SLPSPostEventRecordToFn)(ProcessSerialNumber *psn, void *record);

typedef struct {
  pid_t pid;
  bool windowSet;
  uint32_t window;
  bool stageSet;
  int stage;
  const char *reportPath;
  bool dryRun;
} Options;

typedef struct {
  int stage;
  const char *name;
  bool posted;
  char error[256];
} StageResult;

typedef struct {
  bool ok;
  bool dryRun;
  bool aidTrusted;
  pid_t pid;
  bool windowSet;
  uint32_t window;
  pid_t frontBefore;
  pid_t frontAfter;
  StageResult stages[6];
  size_t stageCount;
} Report;

static const char *stageName(int stage) {
  switch (stage) {
    case 1: return "appkit-deactivate-prev";
    case 2: return "appkit-activate-target";
    case 3: return "cps-taken";
    case 4: return "cps-changed";
    case 5: return "cps-newfront";
    case 6: return "front-process-record";
  }
  return "unknown";
}

static void setError(StageResult *result, const char *format, ...) {
  va_list arguments;
  va_start(arguments, format);
  vsnprintf(result->error, sizeof(result->error), format, arguments);
  va_end(arguments);
  result->posted = false;
}

static bool parseInteger(const char *text, long long minimum, long long maximum, long long *value) {
  char *end = NULL;
  errno = 0;
  long long parsed = strtoll(text, &end, 10);
  if (errno == ERANGE || end == text || *end != '\0' || parsed < minimum || parsed > maximum)
    return false;
  *value = parsed;
  return true;
}

static bool parseOptions(int argc, char **argv, Options *options, char *error, size_t errorSize) {
  options->pid = -1;
  options->windowSet = false;
  options->window = 0;
  options->stageSet = false;
  options->stage = 0;
  options->reportPath = NULL;
  options->dryRun = false;

  for (int index = 1; index < argc; index++) {
    const char *argument = argv[index];
    if (!strcmp(argument, "--dry-run")) {
      options->dryRun = true;
      continue;
    }
    if (!strcmp(argument, "--pid") || !strcmp(argument, "--window") ||
        !strcmp(argument, "--stage") || !strcmp(argument, "--report")) {
      if (index + 1 >= argc) {
        snprintf(error, errorSize, "%s needs a value", argument);
        return false;
      }
      const char *value = argv[++index];
      if (!strcmp(argument, "--pid")) {
        long long parsed;
        if (!parseInteger(value, 1, INT_MAX, &parsed)) {
          snprintf(error, errorSize, "invalid --pid: %s", value);
          return false;
        }
        options->pid = (pid_t)parsed;
      } else if (!strcmp(argument, "--window")) {
        long long parsed;
        if (!parseInteger(value, 0, UINT32_MAX, &parsed)) {
          snprintf(error, errorSize, "invalid --window: %s", value);
          return false;
        }
        options->windowSet = true;
        options->window = (uint32_t)parsed;
      } else if (!strcmp(argument, "--stage")) {
        long long parsed;
        if (!parseInteger(value, 1, 6, &parsed)) {
          snprintf(error, errorSize, "invalid --stage: %s", value);
          return false;
        }
        options->stageSet = true;
        options->stage = (int)parsed;
      } else {
        options->reportPath = value;
      }
      continue;
    }
    snprintf(error, errorSize, "unknown argument: %s", argument);
    return false;
  }

  if (options->pid < 1 && !options->dryRun) {
    snprintf(error, errorSize, "--pid is required");
    return false;
  }
  if (options->pid < 1)
    options->pid = 0;
  return true;
}

static pid_t processIdForSerialNumber(const ProcessSerialNumber *psn) {
  pid_t pid = -1;
  if (GetProcessPID(psn, &pid) != 0 || pid < 1)
    return -1;
  return pid;
}

static pid_t currentFrontPid(void) {
  ProcessSerialNumber psn = {0, 0};
  SLPSGetFrontProcessFn privateGet =
    (SLPSGetFrontProcessFn)dlsym(RTLD_DEFAULT, "_SLPSGetFrontProcess");
  if (privateGet) {
    privateGet(&psn);
    pid_t pid = processIdForSerialNumber(&psn);
    if (pid > 0)
      return pid;
  }
  if (GetFrontProcess(&psn) != 0)
    return -1;
  return processIdForSerialNumber(&psn);
}

static uint32_t frontWindowForPid(pid_t pid) {
  if (pid < 1)
    return 0;
  CFArrayRef windows = CGWindowListCopyWindowInfo(
    kCGWindowListOptionOnScreenOnly | kCGWindowListExcludeDesktopElements,
    kCGNullWindowID
  );
  if (!windows)
    return 0;

  uint32_t window = 0;
  CFIndex count = CFArrayGetCount(windows);
  for (CFIndex index = 0; index < count; index++) {
    CFDictionaryRef info = CFArrayGetValueAtIndex(windows, index);
    CFNumberRef ownerNumber = (CFNumberRef)CFDictionaryGetValue(info, kCGWindowOwnerPID);
    int ownerPid = 0;
    if (!ownerNumber || !CFNumberGetValue(ownerNumber, kCFNumberIntType, &ownerPid) || ownerPid != pid)
      continue;
    CFNumberRef windowNumber = (CFNumberRef)CFDictionaryGetValue(info, kCGWindowNumber);
    if (windowNumber)
      CFNumberGetValue(windowNumber, kCFNumberSInt32Type, &window);
    break;
  }
  CFRelease(windows);
  return window;
}

static bool pidIsAlive(pid_t pid, char *error, size_t errorSize) {
  if (pid < 1) {
    snprintf(error, errorSize, "invalid target pid");
    return false;
  }
  if (kill(pid, 0) == 0 || errno == EPERM)
    return true;
  snprintf(error, errorSize, "target pid %d is unavailable: %s", pid, strerror(errno));
  return false;
}

static bool buildAppKitEvent(
  NSEventType type,
  NSEventModifierFlags modifierFlags,
  NSInteger windowNumber,
  short subtype
) {
  NSEvent *event = [NSEvent otherEventWithType:type
                                       location:NSZeroPoint
                                  modifierFlags:modifierFlags
                                      timestamp:[[NSProcessInfo processInfo] systemUptime]
                                    windowNumber:windowNumber
                                         context:nil
                                        subtype:subtype
                                          data1:0
                                          data2:0];
  return event != nil && event.CGEvent != NULL;
}

static bool postAppKitEvent(
  pid_t pid,
  NSEventType type,
  NSEventModifierFlags modifierFlags,
  NSInteger windowNumber,
  short subtype,
  StageResult *result
) {
  if (!pidIsAlive(pid, result->error, sizeof(result->error)))
    return false;
  NSEvent *event = [NSEvent otherEventWithType:type
                                       location:NSZeroPoint
                                  modifierFlags:modifierFlags
                                      timestamp:[[NSProcessInfo processInfo] systemUptime]
                                    windowNumber:windowNumber
                                         context:nil
                                        subtype:subtype
                                          data1:0
                                          data2:0];
  if (!event) {
    setError(result, "NSEvent construction failed");
    return false;
  }
  CGEventRef cgEvent = event.CGEvent;
  if (!cgEvent) {
    setError(result, "NSEvent has no CGEvent representation");
    return false;
  }
  CGEventPostToPid(pid, cgEvent);
  result->posted = true;
  return true;
}

static void buildFocusRecord(uint8_t record[kFocusRecordLength], uint32_t window) {
  memset(record, 0, kFocusRecordLength);
  record[0x04] = kFocusRecordMarker;
  record[0x08] = kFocusRecordKind;
  record[kFocusRecordWindowOffset] = (uint8_t)(window & 0xFF);
  record[kFocusRecordWindowOffset + 1] = (uint8_t)((window >> 8) & 0xFF);
  record[kFocusRecordWindowOffset + 2] = (uint8_t)((window >> 16) & 0xFF);
  record[kFocusRecordWindowOffset + 3] = (uint8_t)((window >> 24) & 0xFF);
  record[0x8A] = kFocusRecordActive;
}

static bool postFocusRecord(pid_t pid, uint32_t window, StageResult *result) {
  ProcessSerialNumber psn = {0, 0};
  OSStatus processStatus = GetProcessForPID(pid, &psn);
  if (processStatus != 0) {
    setError(result, "GetProcessForPID failed for %d: %d", pid, (int)processStatus);
    return false;
  }

  SLPSSetFrontProcessWithOptionsFn setFront =
    (SLPSSetFrontProcessWithOptionsFn)dlsym(RTLD_DEFAULT, "_SLPSSetFrontProcessWithOptions");
  if (!setFront) {
    setError(result, "missing private symbol: _SLPSSetFrontProcessWithOptions");
    return false;
  }
  SLPSPostEventRecordToFn postRecord =
    (SLPSPostEventRecordToFn)dlsym(RTLD_DEFAULT, "SLPSPostEventRecordTo");
  if (!postRecord) {
    setError(result, "missing private symbol: SLPSPostEventRecordTo");
    return false;
  }

  uint8_t record[kFocusRecordLength];
  buildFocusRecord(record, window);
  setFront(&psn, window, 0x200);
  postRecord(&psn, record);
  result->posted = true;
  return true;
}

static void runStage(const Options *options, StageResult *result) {
  const uint32_t window = options->windowSet ? options->window : 0;
  switch (result->stage) {
    case 1: {
      pid_t frontPid = currentFrontPid();
      if (frontPid < 1) {
        setError(result, "could not resolve current front process");
        return;
      }
      postAppKitEvent(
        frontPid,
        kAppKitDefinedType,
        0,
        frontWindowForPid(frontPid),
        kAppKitDeactivateSubtype,
        result
      );
      return;
    }
    case 2:
      postAppKitEvent(
        options->pid,
        kAppKitDefinedType,
        kActivationModifierFlags,
        window,
        kAppKitActivateSubtype,
        result
      );
      return;
    case 3:
      postAppKitEvent(
        options->pid,
        kProcessNotificationType,
        0,
        window,
        kCpsTakenSubtype,
        result
      );
      return;
    case 4:
      postAppKitEvent(
        options->pid,
        kProcessNotificationType,
        0,
        window,
        kCpsChangedSubtype,
        result
      );
      return;
    case 5:
      postAppKitEvent(
        options->pid,
        kProcessNotificationType,
        0,
        window,
        kCpsNewFrontSubtype,
        result
      );
      return;
    case 6:
      postFocusRecord(options->pid, window, result);
      return;
  }
  setError(result, "unknown stage %d", result->stage);
}

static bool buildDryRunStage(const Options *options, StageResult *result) {
  const uint32_t window = options->windowSet ? options->window : 0;
  switch (result->stage) {
    case 1:
      return buildAppKitEvent(kAppKitDefinedType, 0, 0, kAppKitDeactivateSubtype);
    case 2:
      return buildAppKitEvent(
        kAppKitDefinedType,
        kActivationModifierFlags,
        window,
        kAppKitActivateSubtype
      );
    case 3:
      return buildAppKitEvent(kProcessNotificationType, 0, window, kCpsTakenSubtype);
    case 4:
      return buildAppKitEvent(kProcessNotificationType, 0, window, kCpsChangedSubtype);
    case 5:
      return buildAppKitEvent(kProcessNotificationType, 0, window, kCpsNewFrontSubtype);
    case 6: {
      uint8_t record[kFocusRecordLength];
      buildFocusRecord(record, window);
      return true;
    }
  }
  return false;
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

static void printNullablePid(FILE *stream, pid_t pid) {
  if (pid < 1)
    fputs("null", stream);
  else
    fprintf(stream, "%d", pid);
}

static void printReport(FILE *stream, const Report *report) {
  fputs("{ \"ok\": ", stream);
  fputs(report->ok ? "true" : "false", stream);
  fputs(", \"dryRun\": ", stream);
  fputs(report->dryRun ? "true" : "false", stream);
  fprintf(stream, ", \"pid\": %d, \"window\": ", report->pid);
  if (report->windowSet)
    fprintf(stream, "%u", report->window);
  else
    fputs("null", stream);
  fputs(", \"aidTrusted\": ", stream);
  fputs(report->aidTrusted ? "true" : "false", stream);
  fputs(", \"frontBefore\": ", stream);
  printNullablePid(stream, report->frontBefore);
  fputs(", \"frontAfter\": ", stream);
  printNullablePid(stream, report->frontAfter);
  fputs(", \"stages\": [", stream);
  for (size_t index = 0; index < report->stageCount; index++) {
    if (index)
      fputs(", ", stream);
    const StageResult *stage = &report->stages[index];
    fprintf(stream, "{ \"stage\": %d, \"name\": ", stage->stage);
    jsonString(stream, stage->name);
    fputs(", \"posted\": ", stream);
    fputs(stage->posted ? "true" : "false", stream);
    fputs(", \"error\": ", stream);
    if (stage->error[0])
      jsonString(stream, stage->error);
    else
      fputs("null", stream);
    fputs(" }", stream);
  }
  fputs(" ] }\n", stream);
}

static bool writeReport(const char *path, const Report *report, char *error, size_t errorSize) {
  FILE *stream = fopen(path, "w");
  if (!stream) {
    snprintf(error, errorSize, "could not write report %s: %s", path, strerror(errno));
    return false;
  }
  printReport(stream, report);
  if (fclose(stream) != 0) {
    snprintf(error, errorSize, "could not finish report %s: %s", path, strerror(errno));
    return false;
  }
  return true;
}

static int runProbe(const Options *options) {
  Report report;
  memset(&report, 0, sizeof(report));
  report.dryRun = options->dryRun;
  report.pid = options->pid;
  report.windowSet = options->windowSet;
  report.window = options->window;
  report.aidTrusted = AXIsProcessTrusted();
  report.frontBefore = options->dryRun ? -1 : currentFrontPid();

  if (options->stageSet) {
    report.stageCount = 1;
    report.stages[0].stage = options->stage;
    report.stages[0].name = stageName(options->stage);
  } else {
    report.stageCount = 6;
    for (size_t index = 0; index < report.stageCount; index++) {
      report.stages[index].stage = (int)index + 1;
      report.stages[index].name = stageName((int)index + 1);
    }
  }

  bool allOk = true;
  for (size_t index = 0; index < report.stageCount; index++) {
    StageResult *stage = &report.stages[index];
    if (options->dryRun) {
      if (!buildDryRunStage(options, stage)) {
        setError(stage, "event construction failed");
        allOk = false;
      }
    } else {
      runStage(options, stage);
      if (!stage->posted)
        allOk = false;
    }
  }

  report.ok = allOk;
  report.frontAfter = options->dryRun ? -1 : currentFrontPid();

  char reportError[256] = {0};
  if (options->reportPath && !writeReport(options->reportPath, &report, reportError, sizeof(reportError))) {
    fprintf(stderr, "belief probe failed: %s\n", reportError);
    return 2;
  }

  if (options->dryRun) {
    printReport(stdout, &report);
    if (!report.ok) {
      const char *why = "event construction failed";
      for (size_t index = 0; index < report.stageCount; index++) {
        if (report.stages[index].error[0]) {
          why = report.stages[index].error;
          break;
        }
      }
      fprintf(stderr, "belief probe dry-run failed: %s\n", why);
      return 2;
    }
    puts("belief probe dry-run ok");
    return 0;
  }

  if (!report.ok) {
    const char *why = "stage failed";
    for (size_t index = 0; index < report.stageCount; index++) {
      if (report.stages[index].error[0]) {
        why = report.stages[index].error;
        break;
      }
    }
    fprintf(stderr, "belief probe failed: %s\n", why);
    return 2;
  }
  puts("belief probe ok");
  return 0;
}

int main(int argc, char **argv) {
  @autoreleasepool {
    Options options;
    char error[256] = {0};
    if (!parseOptions(argc, argv, &options, error, sizeof(error))) {
      fprintf(stderr, "belief probe failed: %s\n", error);
      return 2;
    }
    return runProbe(&options);
  }
}
