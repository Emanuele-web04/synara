// Minimal owned AppKit target for verify-background-launch.mjs. It never
// activates itself; the control entrypoint can only hide or stop its exact bundle.
#import <AppKit/AppKit.h>

@interface BackgroundLaunchDelegate : NSObject <NSApplicationDelegate>
@property(strong) NSWindow *window;
@property NSInteger reopenCount;
@end

@implementation BackgroundLaunchDelegate
- (void)record {
    NSString *path = [[NSBundle.mainBundle.bundlePath stringByDeletingLastPathComponent]
        stringByAppendingPathComponent:@"state.json"];
    NSDictionary *state = @{@"pid": @(getpid()), @"reopenCount": @(self.reopenCount),
        @"windows": @(NSApp.windows.count), @"hidden": @(NSApp.hidden)};
    NSData *data = [NSJSONSerialization dataWithJSONObject:state options:0 error:nil];
    [data writeToFile:path atomically:YES];
}
- (void)applicationDidFinishLaunching:(NSNotification *)note {
    self.window = [[NSWindow alloc] initWithContentRect:NSMakeRect(20, 20, 280, 140)
        styleMask:NSWindowStyleMaskTitled | NSWindowStyleMaskClosable
        backing:NSBackingStoreBuffered defer:NO];
    self.window.title = NSBundle.mainBundle.bundleIdentifier;
    self.window.releasedWhenClosed = NO;
    NSTextField *label = [NSTextField labelWithString:@"Owned background-launch verification"];
    label.frame = NSMakeRect(15, 50, 250, 40);
    [self.window.contentView addSubview:label];
    [self.window orderBack:nil];
    [self record];
}
- (BOOL)applicationShouldHandleReopen:(NSApplication *)app hasVisibleWindows:(BOOL)flag {
    self.reopenCount += 1;
    [self record];
    return YES;
}
- (void)application:(NSApplication *)app openFiles:(NSArray<NSString *> *)files {
    [app replyToOpenOrPrint:NSApplicationDelegateReplySuccess];
    [self record];
}
- (void)applicationDidHide:(NSNotification *)note { [self record]; }
- (void)applicationDidUnhide:(NSNotification *)note { [self record]; }
@end

int main(int argc, const char *argv[]) {
    @autoreleasepool {
        if (argc == 4) {
            if (strcmp(argv[1], "--terminate-bundle") == 0) {
                NSString *identifier = @(argv[2]);
                if (![identifier hasPrefix:@"app.synara.fixture.background-launch."]) return 2;
                for (NSRunningApplication *owned in
                    [NSRunningApplication runningApplicationsWithBundleIdentifier:identifier]) {
                    if ([owned.bundleURL.path isEqualToString:@(argv[3])]) [owned terminate];
                }
                return 0;
            }
            NSRunningApplication *app = [NSRunningApplication
                runningApplicationWithProcessIdentifier:atoi(argv[2])];
            if (!app || ![app.bundleIdentifier hasPrefix:@"app.synara.fixture.background-launch."]
                || ![app.bundleURL.path isEqualToString:@(argv[3])]) return 2;
            NSString *command = @(argv[1]);
            if ([command isEqualToString:@"--hide"]) return [app hide] ? 0 : 3;
            if ([command isEqualToString:@"--terminate"]) return [app terminate] ? 0 : 3;
            if ([command isEqualToString:@"--state"]) {
                printf("{\"hidden\":%s}\n", app.hidden ? "true" : "false");
                return 0;
            }
            return 4;
        }
        if (argc != 1) return 4;
        NSApplication *app = NSApplication.sharedApplication;
        BackgroundLaunchDelegate *delegate = [BackgroundLaunchDelegate new];
        app.delegate = delegate;
        [app run];
    }
}
