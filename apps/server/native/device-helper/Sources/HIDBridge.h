// HID event injection into a booted simulator.
//
// Two transports behind one interface, chosen by CoreSimulator version:
//
// - Xcode 27 (CoreSimulator 1155.4) and later: XPC dictionaries to the guest's
//   `dtuhidd` daemon (DTUHIDTransport). The guest drops legacy Indigo input
//   there while the host-side send still succeeds, so there is no fallback.
// - Earlier toolchains: Indigo messages built by SimulatorKit's
//   `IndigoHIDMessageFor*` C functions and delivered through
//   `SimDeviceLegacyHIDClient`. The struct layout and the two-payload touch
//   message are ported from facebook/idb's FBSimulatorIndigoHID.
//
// Objective-C because it does raw struct surgery on private message buffers.

#import <Foundation/Foundation.h>

#import "DTUHIDTransport.h"

NS_ASSUME_NONNULL_BEGIN

/// Hardware buttons addressable over HID. Rotation is deliberately absent: the
/// simulator exposes no rotation button, so orientation changes go through
/// `simctl` at the UI level instead (see HEADER.md).
typedef NS_ENUM(NSInteger, SynaraHardwareButton) {
  SynaraHardwareButtonHome,
  SynaraHardwareButtonLock,
  SynaraHardwareButtonSide,
  SynaraHardwareButtonSiri,
  SynaraHardwareButtonVolumeUp,
  SynaraHardwareButtonVolumeDown,
};

/// Returns NO (and fills `name`-specific errors) for an unknown button name.
BOOL SynaraHardwareButtonFromName(NSString *name, SynaraHardwareButton *outButton);

@interface SynaraHIDBridge : NSObject

/// Connects a HID client to `device` (a `SimDevice`). Returns NO on failure.
- (BOOL)attachToDevice:(id)device
                 error:(NSError **)error NS_SWIFT_NAME(attach(toDevice:));

/// Count of events this bridge could not deliver: no client, a missing private
/// symbol, or a send the simulator rejected.
///
/// Every injection path used to fail silently while the RPC layer still acked
/// `{"ok": true}`, so a stale or half-attached HID client looked identical to a
/// working one. An agent cannot see the screen, so a silent no-op is the worst
/// possible failure mode; callers compare this before and after an injection
/// and turn any increase into an error.
@property(nonatomic, readonly) NSInteger undeliveredEventCount;

/// Why the most recent undelivered event was not delivered, for the RPC error.
@property(nonatomic, readonly, copy, nullable) NSString *undeliveredReason;

/// `dtuhid` or `indigo`: which transport this attachment injects through.
@property(nonatomic, readonly, copy) NSString *transportName;

/// Starts one bounded RPC input. Delivery errors describe the whole operation,
/// not just the last failed key, so a partially sent operation is never replayed.
- (void)beginInput NS_SWIFT_NAME(beginInput());

/// Touch down/up at a normalized display point (0..1, origin top-left).
- (void)sendTouchAtX:(double)x y:(double)y down:(BOOL)down
    NS_SWIFT_NAME(sendTouch(x:y:down:));

/// Press-and-release at a normalized point, holding for `holdMs`.
- (void)tapAtX:(double)x y:(double)y holdMs:(NSInteger)holdMs
    NS_SWIFT_NAME(tap(x:y:holdMs:));

/// A drag from start to end over `durationMs`, interpolated into steps so the
/// gesture recognizers on the far side see a real swipe rather than a teleport.
///
/// `edge` marks a drag that starts at a screen edge, which the guest reads as
/// the OS edge gesture (back, notification shade, home, Control Center). Only
/// the DTUHID transport can carry it; Indigo sends a plain drag.
- (void)dragFromX:(double)startX
                y:(double)startY
              toX:(double)endX
             endY:(double)endY
       durationMs:(NSInteger)durationMs
             edge:(SynaraTouchEdge)edge
    NS_SWIFT_NAME(drag(startX:startY:endX:endY:durationMs:edge:));

/// A key down or up by USB HID usage code.
- (void)sendKeyUsage:(uint32_t)usage down:(BOOL)down
    NS_SWIFT_NAME(sendKey(usage:down:));

/// Press and release a key, holding briefly so the guest registers it.
- (void)tapKeyUsage:(uint32_t)usage NS_SWIFT_NAME(tapKey(usage:));

/// Types `text` by mapping each character to HID usages, shifting as needed.
/// Returns the count of characters that had no mapping (skipped).
- (NSInteger)typeText:(NSString *)text NS_SWIFT_NAME(type(text:));

- (void)sendButton:(SynaraHardwareButton)button down:(BOOL)down
    NS_SWIFT_NAME(sendButton(_:down:));
- (void)tapButton:(SynaraHardwareButton)button NS_SWIFT_NAME(tapButton(_:));

/// Releases the transport. Called when an attachment is replaced, so the old
/// one's background connection attempts stop instead of piling up.
- (void)invalidate;

@end

NS_ASSUME_NONNULL_END
