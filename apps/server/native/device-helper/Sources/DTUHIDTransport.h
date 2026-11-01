// HID delivery over the simulator's `dtuhidd` daemon (CoreSimulator 1155.4+,
// i.e. Xcode 27 and later).
//
// From that CoreSimulator the guest drops legacy Indigo button and keyboard
// events and delivers Indigo touches unreliably, while the host-side send still
// succeeds. Events instead travel as plain XPC dictionaries to a CoreDevice HID
// feature service that `dtuhidd` vends inside the simulator. The wire format
// (service names, the `messageType`/`isBarrier`/`featureIdentifier`/`payload`
// envelope, and the payload keys) was learned from facebook/idb's MIT-licensed
// FBSimulatorControl/HID sources; this is an independent implementation.

#import <Foundation/Foundation.h>

NS_ASSUME_NONNULL_BEGIN

/// Where a contact starts. Non-zero turns a swipe into the OS edge gesture
/// (back, notification shade, home, Control Center).
typedef NS_ENUM(uint64_t, SynaraTouchEdge) {
  SynaraTouchEdgeNone = 0,
  SynaraTouchEdgeTop = 1,
  SynaraTouchEdgeLeft = 2,
  SynaraTouchEdgeBottom = 3,
  SynaraTouchEdgeRight = 4,
};

/// Whether this host's CoreSimulator routes input through `dtuhidd` and drops
/// legacy Indigo input. Decided by version alone: `dtuhidd` is demand-launched,
/// so whether it happens to be running says nothing.
BOOL SynaraCoreSimulatorUsesDTUHID(void);

/// The loaded CoreSimulator version string, or nil when it cannot be read.
NSString *_Nullable SynaraCoreSimulatorVersion(void);

@interface SynaraDTUHIDTransport : NSObject

/// Starts connecting to `device` (a `SimDevice`) in the background and proving
/// a live daemon answers. Returns immediately; input waits for readiness.
- (instancetype)initWithDevice:(id)device NS_DESIGNATED_INITIALIZER;
- (instancetype)init NS_UNAVAILABLE;

/// Blocks up to `timeout` seconds for the liveness probe. On failure `error`
/// says why (not booted, service missing, daemon not answering), and a later
/// call starts a fresh attempt rather than reusing the failure forever.
- (BOOL)waitUntilReadyWithTimeout:(NSTimeInterval)timeout
                            error:(NSError **)error NS_SWIFT_NAME(waitUntilReady(timeout:));

/// One digitizer contact. `down` after a previous `down` is a move; `up` ends
/// the contact. Coordinates are normalized 0..1, origin top-left.
- (BOOL)sendTouchAtX:(double)x y:(double)y down:(BOOL)down edge:(SynaraTouchEdge)edge;

/// A USB HID keyboard usage, down or up.
- (BOOL)sendKeyUsage:(uint32_t)usage down:(BOOL)down;

/// A HID Consumer-page button (home, power, Siri, volume), down or up.
- (BOOL)sendConsumerUsage:(uint16_t)usage down:(BOOL)down;

/// Waits until XPC has handed every earlier send to the daemon, so an RPC
/// reply never runs ahead of the gesture it reports. NO when it timed out or
/// the connection died.
- (BOOL)flushWithTimeout:(NSTimeInterval)timeout;

/// Closes the connection and stops any warm-up still retrying. Final: a
/// replaced attachment gets a new transport rather than reviving this one.
- (void)invalidate;

@end

NS_ASSUME_NONNULL_END
