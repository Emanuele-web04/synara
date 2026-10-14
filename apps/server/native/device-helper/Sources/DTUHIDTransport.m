#import "DTUHIDTransport.h"

#import <dlfcn.h>
#import <objc/message.h>
#import <xpc/xpc.h>

// The feature service `dtuhidd` vends for touches, keys and hardware buttons.
static const char *const kDigitizerService = "com.apple.coredevice.feature.remote.hid.digitizer";

// The first CoreSimulator that injects `dtuhidd` and stops honouring Indigo.
static NSString *const kFirstDTUHIDCoreSimulatorVersion = @"1155.4";

// Liveness: the probe is the send that demand-launches the daemon, so its
// deadline pays for a cold start. A daemon that aborted during a slow boot is
// respawned by launchd on a throttle, which is what the retries wait out.
static const NSTimeInterval kLivenessTimeout = 4.0;
static const NSTimeInterval kLivenessBackoff = 3.0;
static const NSInteger kLivenessAttempts = 5;
// After the first reply the daemon still opens its device; events sent inside
// this window can be dropped.
static const useconds_t kDeviceOpenTailMicros = 200000;

// `dtuhidd` decodes these as UInt64-backed enums; strings are rejected.
static const uint64_t kDigitizerStart = 0;
static const uint64_t kDigitizerPosition = 1;
static const uint64_t kDigitizerEnd = 2;
// HIDButtonState is 1-based: 0 fails to decode.
static const uint64_t kButtonDown = 1;
static const uint64_t kButtonUp = 2;
static const uint64_t kConsumerPage = 0x0c;

typedef void *(*SynaraEndpointFromPortFn)(mach_port_t, uint64_t, uint64_t);
typedef void (*SynaraEnableSim2HostFn)(xpc_connection_t);

static NSString *const kErrorDomain = @"dev.synara.device-helper.dtuhid";

static NSError *SynaraDTUHIDError(NSInteger code, NSString *message) {
  return [NSError errorWithDomain:kErrorDomain
                             code:code
                         userInfo:@{NSLocalizedDescriptionKey: message}];
}

NSString *SynaraCoreSimulatorVersion(void) {
  NSBundle *bundle = [NSBundle bundleWithIdentifier:@"com.apple.CoreSimulator"];
  NSString *version = bundle.infoDictionary[@"CFBundleVersion"];
  if (version.length > 0) {
    return version;
  }
  NSDictionary *info = [NSDictionary
      dictionaryWithContentsOfFile:@"/Library/Developer/PrivateFrameworks/CoreSimulator.framework/"
                                   @"Versions/A/Resources/Info.plist"];
  version = info[@"CFBundleVersion"];
  return version.length > 0 ? version : nil;
}

BOOL SynaraCoreSimulatorUsesDTUHID(void) {
  NSString *version = SynaraCoreSimulatorVersion();
  if (version == nil) {
    return NO;
  }
  // Numeric so 1155.10 sorts above 1155.4.
  return [version compare:kFirstDTUHIDCoreSimulatorVersion options:NSNumericSearch] !=
         NSOrderedAscending;
}

static xpc_object_t SynaraEnvelope(const char *messageType, xpc_object_t payload, BOOL barrier) {
  xpc_object_t message = xpc_dictionary_create(NULL, NULL, 0);
  xpc_dictionary_set_string(message, "messageType", messageType);
  xpc_dictionary_set_bool(message, "isBarrier", barrier);
  xpc_dictionary_set_string(message, "featureIdentifier", kDigitizerService);
  xpc_dictionary_set_value(message, "payload", payload);
  return message;
}

static xpc_object_t SynaraKeyboardPayload(uint64_t usage, uint64_t state) {
  xpc_object_t payload = xpc_dictionary_create(NULL, NULL, 0);
  xpc_dictionary_set_uint64(payload, "usageCode", usage);
  xpc_dictionary_set_uint64(payload, "state", state);
  return payload;
}

@implementation SynaraDTUHIDTransport {
  id _device;
  dispatch_queue_t _eventQueue;
  dispatch_queue_t _connectQueue;
  dispatch_group_t _attemptGroup;
  xpc_connection_t _connection;
  BOOL _ready;
  BOOL _attempting;
  NSError *_lastError;
  BOOL _contactActive;
  /// Set by `invalidate`: a replaced transport stops warming up at once.
  BOOL _invalidated;
  /// Signalled by `invalidate` to cut a retry backoff short.
  dispatch_semaphore_t _cancelled;
}

- (instancetype)initWithDevice:(id)device {
  self = [super init];
  if (self) {
    _device = device;
    _eventQueue = dispatch_queue_create("dev.synara.device-helper.dtuhid", DISPATCH_QUEUE_SERIAL);
    _connectQueue =
        dispatch_queue_create("dev.synara.device-helper.dtuhid.connect", DISPATCH_QUEUE_SERIAL);
    _attemptGroup = dispatch_group_create();
    _cancelled = dispatch_semaphore_create(0);
    // Warm up now: the first gesture would otherwise pay the daemon's cold
    // start, which can outlast an RPC deadline right after a boot.
    [self startAttemptIfNeeded];
  }
  return self;
}

#pragma mark - Connection

- (void)startAttemptIfNeeded {
  @synchronized(self) {
    if ((_ready && _connection != nil) || _attempting || _invalidated) {
      return;
    }
    _attempting = YES;
  }
  dispatch_group_enter(_attemptGroup);
  dispatch_async(_connectQueue, ^{
    NSError *error = nil;
    xpc_connection_t connection = nil;
    for (NSInteger attempt = 1; attempt <= kLivenessAttempts && !self.isInvalidated; attempt++) {
      connection = [self connectOnceWithError:&error];
      if (connection != nil || error.code == 1) {
        break;  // Connected, or the toolchain lacks the symbols: retrying cannot help.
      }
      fprintf(stderr, "[device-helper] dtuhidd did not answer (attempt %ld of %ld): %s\n",
              (long)attempt, (long)kLivenessAttempts, error.localizedDescription.UTF8String);
      if (attempt < kLivenessAttempts) {
        // Waits out the backoff unless the transport is replaced meanwhile:
        // a re-attach during a cold boot must not leave old warm-ups running.
        dispatch_semaphore_wait(
            self->_cancelled,
            dispatch_time(DISPATCH_TIME_NOW, (int64_t)(kLivenessBackoff * NSEC_PER_SEC)));
      }
    }
    if (connection != nil && self.isInvalidated) {
      xpc_connection_cancel(connection);
      connection = nil;
      error = SynaraDTUHIDError(5, @"the input transport was replaced");
    }
    @synchronized(self) {
      self->_connection = connection;
      self->_ready = connection != nil;
      self->_lastError = connection != nil ? nil : error;
      self->_attempting = NO;
      self->_contactActive = NO;
    }
    dispatch_group_leave(self->_attemptGroup);
  });
}

/// Looks the service up in the simulator's bootstrap namespace, builds a
/// sim-to-host XPC connection from the port, and proves a daemon answers.
/// Every step before the probe succeeds against a daemon that cannot run, and
/// sends to it report no error, so an unanswered probe is the only signal that
/// separates a working transport from a black hole.
- (nullable xpc_connection_t)connectOnceWithError:(NSError **)error {
  SynaraEndpointFromPortFn endpointFromPort =
      (SynaraEndpointFromPortFn)dlsym(RTLD_DEFAULT, "xpc_endpoint_create_mach_port_4sim");
  SynaraEnableSim2HostFn enableSim2Host =
      (SynaraEnableSim2HostFn)dlsym(RTLD_DEFAULT, "xpc_connection_enable_sim2host_4sim");
  if (endpointFromPort == NULL || enableSim2Host == NULL) {
    *error = SynaraDTUHIDError(1, @"this macOS lacks the private _4sim XPC endpoint symbols");
    return nil;
  }

  SEL lookupSelector = NSSelectorFromString(@"lookup:error:");
  if (![_device respondsToSelector:lookupSelector]) {
    *error = SynaraDTUHIDError(1, @"SimDevice cannot look up guest services on this Xcode");
    return nil;
  }
  NSError *lookupError = nil;
  NSString *service = @(kDigitizerService);
  mach_port_t port = ((mach_port_t (*)(id, SEL, NSString *, NSError **))objc_msgSend)(
      _device, lookupSelector, service, &lookupError);
  if (port == MACH_PORT_NULL) {
    *error = SynaraDTUHIDError(
        2, [NSString stringWithFormat:@"the simulator does not vend %@ yet (%@)", service,
                                      lookupError.localizedDescription ?: @"lookup failed"]);
    return nil;
  }

  // The endpoint consumes the lookup's send right and is returned +1.
  xpc_object_t endpoint = (__bridge_transfer xpc_object_t)endpointFromPort(port, 0, 0);
  if (endpoint == nil) {
    *error = SynaraDTUHIDError(3, @"could not create an XPC endpoint for dtuhidd");
    return nil;
  }
  xpc_connection_t connection = xpc_connection_create_from_endpoint((xpc_endpoint_t)endpoint);
  if (connection == nil) {
    *error = SynaraDTUHIDError(3, @"could not create an XPC connection to dtuhidd");
    return nil;
  }
  // Without the sim-to-host mark the daemon sees the peer but never a payload.
  enableSim2Host(connection);
  xpc_connection_set_target_queue(connection, _eventQueue);
  __weak SynaraDTUHIDTransport *weakSelf = self;
  xpc_connection_set_event_handler(connection, ^(xpc_object_t event) {
    if (event == XPC_ERROR_CONNECTION_INVALID) {
      [weakSelf connectionInvalidated:connection];
    } else if (event == XPC_ERROR_CONNECTION_INTERRUPTED) {
      // The daemon lost contact state. Re-probe before sending a fresh gesture.
      [weakSelf connectionInvalidated:connection];
      xpc_connection_cancel(connection);
      fprintf(stderr, "[device-helper] dtuhidd connection was interrupted\n");
    }
  });
  xpc_connection_resume(connection);

  if (![self probeConnection:connection error:error]) {
    xpc_connection_cancel(connection);
    return nil;
  }
  usleep(kDeviceOpenTailMicros);
  return connection;
}

/// A barrier carrying keyboard usage 0 ("no event"), which the daemon answers
/// without the guest seeing a keypress.
- (BOOL)probeConnection:(xpc_connection_t)connection error:(NSError **)error {
  xpc_object_t probe = SynaraEnvelope("IndigoKeyboardButtonEvent",
                                      SynaraKeyboardPayload(0, kButtonUp), YES);
  dispatch_semaphore_t answered = dispatch_semaphore_create(0);
  __block BOOL alive = NO;
  xpc_connection_send_message_with_reply(connection, probe, _eventQueue, ^(xpc_object_t reply) {
    alive = xpc_get_type(reply) != XPC_TYPE_ERROR;
    dispatch_semaphore_signal(answered);
  });
  long timedOut = dispatch_semaphore_wait(
      answered, dispatch_time(DISPATCH_TIME_NOW, (int64_t)(kLivenessTimeout * NSEC_PER_SEC)));
  if (timedOut != 0 || !alive) {
    *error = SynaraDTUHIDError(
        4, timedOut != 0 ? @"dtuhidd did not answer its liveness probe"
                         : @"dtuhidd refused the liveness probe");
    return NO;
  }
  return YES;
}

- (void)connectionInvalidated:(xpc_connection_t)connection {
  @synchronized(self) {
    if (_connection != connection) {
      return;
    }
    _connection = nil;
    _ready = NO;
    _contactActive = NO;
    _lastError = SynaraDTUHIDError(5, @"the dtuhidd connection was invalidated");
  }
  fprintf(stderr, "[device-helper] dtuhidd connection was invalidated; the next input reconnects\n");
}

- (BOOL)waitUntilReadyWithTimeout:(NSTimeInterval)timeout error:(NSError **)error {
  [self startAttemptIfNeeded];
  long timedOut = dispatch_group_wait(
      _attemptGroup, dispatch_time(DISPATCH_TIME_NOW, (int64_t)(timeout * NSEC_PER_SEC)));
  @synchronized(self) {
    if (_ready && _connection != nil) {
      return YES;
    }
    if (error) {
      *error = timedOut != 0
                   ? SynaraDTUHIDError(6, @"the simulator's input service (dtuhidd) is still "
                                          @"starting; nothing was sent")
                   : (_lastError ?: SynaraDTUHIDError(7, @"dtuhidd is unreachable"));
    }
    return NO;
  }
}

- (nullable xpc_connection_t)liveConnection {
  @synchronized(self) {
    return _ready ? _connection : nil;
  }
}

- (BOOL)isInvalidated {
  @synchronized(self) {
    return _invalidated;
  }
}

- (void)invalidate {
  xpc_connection_t connection = nil;
  BOOL wasInvalidated;
  @synchronized(self) {
    wasInvalidated = _invalidated;
    _invalidated = YES;
    connection = _connection;
    _connection = nil;
    _ready = NO;
  }
  if (!wasInvalidated) {
    dispatch_semaphore_signal(_cancelled);
  }
  if (connection != nil) {
    xpc_connection_cancel(connection);
  }
}

- (void)dealloc {
  [self invalidate];
}

#pragma mark - Sends

- (BOOL)send:(xpc_object_t)message {
  xpc_connection_t connection = [self liveConnection];
  if (connection == nil) {
    return NO;
  }
  xpc_connection_send_message(connection, message);
  return YES;
}

- (BOOL)sendTouchAtX:(double)x y:(double)y down:(BOOL)down edge:(SynaraTouchEdge)edge {
  uint64_t phase;
  @synchronized(self) {
    if (!down) {
      phase = kDigitizerEnd;
      _contactActive = NO;
    } else if (_contactActive) {
      phase = kDigitizerPosition;
    } else {
      phase = kDigitizerStart;
      _contactActive = YES;
    }
  }
  xpc_object_t point = xpc_dictionary_create(NULL, NULL, 0);
  xpc_dictionary_set_double(point, "x", x);
  xpc_dictionary_set_double(point, "y", y);
  xpc_object_t payload = xpc_dictionary_create(NULL, NULL, 0);
  xpc_dictionary_set_value(payload, "pointOne", point);
  xpc_dictionary_set_uint64(payload, "eventType", phase);
  // Every contact of an edge gesture carries the edge: the guest reads it off
  // whichever contact it inspects.
  xpc_dictionary_set_uint64(payload, "edge", (uint64_t)edge);
  xpc_dictionary_set_uint64(payload, "target", 0);
  return [self send:SynaraEnvelope("IndigoDigitizerEvent", payload, NO)];
}

- (BOOL)sendKeyUsage:(uint32_t)usage down:(BOOL)down {
  return [self send:SynaraEnvelope("IndigoKeyboardButtonEvent",
                                   SynaraKeyboardPayload(usage, down ? kButtonDown : kButtonUp),
                                   NO)];
}

- (BOOL)sendConsumerUsage:(uint16_t)usage down:(BOOL)down {
  xpc_object_t payload = xpc_dictionary_create(NULL, NULL, 0);
  xpc_dictionary_set_uint64(payload, "usagePage", kConsumerPage);
  xpc_dictionary_set_uint64(payload, "usageCode", usage);
  xpc_dictionary_set_uint64(payload, "state", down ? kButtonDown : kButtonUp);
  return [self send:SynaraEnvelope("IndigoButtonEvent", payload, NO)];
}

- (BOOL)flushWithTimeout:(NSTimeInterval)timeout {
  xpc_connection_t connection = [self liveConnection];
  if (connection == nil) {
    return NO;
  }
  dispatch_semaphore_t sent = dispatch_semaphore_create(0);
  xpc_connection_send_barrier(connection, ^{
    dispatch_semaphore_signal(sent);
  });
  return dispatch_semaphore_wait(
             sent, dispatch_time(DISPATCH_TIME_NOW, (int64_t)(timeout * NSEC_PER_SEC))) == 0;
}

@end
