// Native owner-boundary regression: no simulator or private framework is loaded.
// Compile with HIDBridge.m + DTUHIDTransport.m and Foundation/CoreGraphics.
#import <Foundation/Foundation.h>
#import "../Sources/HIDBridge.h"

@interface StubTransport : NSObject
@property(nonatomic) NSInteger sent;
@property(nonatomic) NSInteger failAfter;
@property(nonatomic) BOOL failOnce;
@property(nonatomic) BOOL failed;
@property(nonatomic) NSMutableArray<NSDictionary *> *keys;
@end
@implementation StubTransport
- (BOOL)waitUntilReadyWithTimeout:(NSTimeInterval)timeout error:(NSError **)error {
  if (_failAfter >= 0 && _sent >= _failAfter && !(_failOnce && _failed)) {
    _failed = YES;
    if (error) *error = [NSError errorWithDomain:@"test" code:1 userInfo:@{NSLocalizedDescriptionKey: @"still starting; nothing was sent"}];
    return NO;
  }
  return YES;
}
- (BOOL)sendKeyUsage:(uint32_t)usage down:(BOOL)down { _sent++; [_keys addObject:@{@"usage": @(usage), @"down": @(down)}]; return YES; }
- (BOOL)sendTouchAtX:(double)x y:(double)y down:(BOOL)down edge:(SynaraTouchEdge)edge { _sent++; return YES; }
- (BOOL)flushWithTimeout:(NSTimeInterval)timeout { return YES; }
- (void)invalidate {}
@end

int main(void) {
  @autoreleasepool {
    SynaraHIDBridge *bridge = [SynaraHIDBridge new];
    StubTransport *transport = [StubTransport new];
    [bridge setValue:transport forKey:@"dtuhid"];
    transport.failAfter = 2;
    [bridge beginInput];
    [bridge typeText:@"abc"];
    NSCAssert(transport.sent == 2, @"Input continued after a failed readiness check");
    NSCAssert([bridge.undeliveredReason containsString:@"partially delivered"], @"A delivered prefix was advertised as wholly unsent");
    NSCAssert(![bridge.undeliveredReason containsString:@"nothing was sent"], @"Partial input is replayable by the backend");

    transport.sent = 0;
    transport.failAfter = 0;
    [bridge beginInput];
    [bridge typeText:@"abc"];
    NSCAssert(transport.sent == 0, @"Unready input was sent");
    NSCAssert([bridge.undeliveredReason hasPrefix:@"nothing was sent:"], @"Wholly refused input lost its delivery evidence");

    transport.failAfter = -1;
    [bridge beginInput];
    [bridge tapAtX:0.5 y:0.5 holdMs:14000];
    NSCAssert(transport.sent == 0, @"Over-budget input started a contact");
    transport.sent = 0;
    transport.failAfter = 2;
    transport.failOnce = YES;
    transport.failed = NO;
    transport.keys = [NSMutableArray new];
    [bridge beginInput];
    [bridge typeText:@"Ab"];
    NSCAssert(transport.keys.count == 4, @"Cleanup did not release the character and Shift, or kept typing");
    NSCAssert([transport.keys[2][@"down"] isEqual:@NO] && [transport.keys[3][@"down"] isEqual:@NO], @"Cleanup queued another key-down");
    NSCAssert([transport.keys[3][@"usage"] isEqual:@0xe1], @"Shift was left pressed");
    puts("Input delivery, deadline and held-key cleanup regressions passed");
  }
  return 0;
}
