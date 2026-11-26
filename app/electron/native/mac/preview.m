// macOS Node-API addon for the character preview’s Mach connection and non-activating windows.
// This process checks in
// `<bundle id>.preview.<pid>`; the renderer gets the name as `--agentic-complex-preview-rendezvous`, looks it up and says `hello`
// with its own receive port. rendezvous(), start(name, onMessage), send(json), stop(), mainBundle(),
// setPreventsActivation(nativeWindowHandle).
#import <AppKit/AppKit.h>
#import <IOSurface/IOSurface.h>
#include <bootstrap.h>
#include <mach/mach.h>
#include <node_api.h>
#include <objc/message.h>
#include <stddef.h>
#include <string.h>
#include <unistd.h>

#define MAX_JSON 8192
#define WIRE_ID 0x45575056
#define SEND_TIMEOUT_MS 100

/** Both directions; sent as `offsetof(json) + length` rounded up to 4. */
typedef struct {
  mach_msg_header_t header;
  mach_msg_body_t body;
  mach_msg_port_descriptor_t port;
  uint64_t sequence;
  uint32_t length;
  char json[MAX_JSON];
} EWPreviewWire;

typedef struct {
  EWPreviewWire wire;
  mach_msg_trailer_t trailer;
} EWPreviewReceive;

/** The rendezvous port's messages arrive on this queue, and start, send and stop run their Mach part on it. */
static dispatch_queue_t queue;
static char rendezvousName[512];
static mach_port_t rendezvousPort = MACH_PORT_NULL;
static dispatch_source_t source;
/** Queue only: the host's port from its last `hello`, and the JS connection as the queue sees it. */
static mach_port_t host = MACH_PORT_NULL;
static bool started, connectPending;
/** Sends of a started connection before any host said hello, in order; flushed after `connected`. The renderer takes seconds to
 *  start, and the page sends `view` and `load` at once. */
#define MAX_PENDING 16
static char *pending[MAX_PENDING];
static size_t pendingLength[MAX_PENDING], pendingCount;
static uint64_t startedToken;
/** Made once and kept: an old connection's events can still be in flight when start replaces the receiver. */
static napi_threadsafe_function tsfn;
static napi_ref receiver;
/** Bumped by start and stop on the JS thread; a message of an older connection is dropped there. */
static uint64_t generation;

typedef struct {
  uint64_t token;
  char *json;
  size_t length;
  IOSurfaceRef surface;
  uint64_t sequence;
} Delivery;

static void Throw(napi_env env, const char *message) { napi_throw_type_error(env, NULL, message); }

static void ReleaseSurface(napi_env env, void *data, void *hint) { CFRelease((IOSurfaceRef)data); }

static void SetUint(napi_env env, napi_value object, const char *name, double value) {
  napi_value n;
  napi_create_double(env, value, &n);
  napi_set_named_property(env, object, name, n);
}

/** `{handle: Buffer(8) holding this process's IOSurfaceRef, width, height, pixelFormat, bytesPerRow, id}`; the ref lives as long as
 *  the object. */
static napi_value SurfaceObject(napi_env env, IOSurfaceRef surface) {
  napi_value result, buffer;
  napi_create_object(env, &result);
  napi_create_buffer_copy(env, sizeof(surface), &surface, NULL, &buffer);
  napi_set_named_property(env, result, "handle", buffer);
  SetUint(env, result, "width", IOSurfaceGetWidth(surface));
  SetUint(env, result, "height", IOSurfaceGetHeight(surface));
  SetUint(env, result, "pixelFormat", IOSurfaceGetPixelFormat(surface));
  SetUint(env, result, "bytesPerRow", IOSurfaceGetBytesPerRow(surface));
  SetUint(env, result, "id", IOSurfaceGetID(surface));
  CFRetain(surface);
  napi_add_finalizer(env, result, (void *)surface, ReleaseSurface, NULL, NULL);
  return result;
}

static void CallJS(napi_env env, napi_value unused, void *context, void *data) {
  Delivery *d = data;
  if (env != NULL && d->token == generation && receiver != NULL) {
    napi_value args[3], global, callback;
    napi_get_reference_value(env, receiver, &callback);
    napi_create_string_utf8(env, d->json, d->length, &args[0]);
    if (d->surface) args[1] = SurfaceObject(env, d->surface);
    else napi_get_null(env, &args[1]);
    napi_create_double(env, (double)d->sequence, &args[2]);
    napi_get_global(env, &global);
    napi_call_function(env, global, callback, 3, args, NULL);
  }
  if (d->surface) CFRelease(d->surface);
  free(d->json);
  free(d);
}

/** Queue only. Takes `surface`'s reference. */
static void Deliver(const char *json, size_t length, IOSurfaceRef surface, uint64_t sequence) {
  Delivery *d = calloc(1, sizeof(Delivery));
  d->token = startedToken;
  d->json = malloc(length);
  memcpy(d->json, json, length);
  d->length = length;
  d->surface = surface;
  d->sequence = sequence;
  if (napi_call_threadsafe_function(tsfn, d, napi_tsfn_nonblocking) != napi_ok) {
    if (d->surface) CFRelease(d->surface);
    free(d->json);
    free(d);
  }
}

/** Queue only. False when `to` is null or the send fails within the timeout. */
static bool SendWire(mach_port_t to, const char *json, size_t length) {
  if (to == MACH_PORT_NULL || length == 0 || length > MAX_JSON) return false;
  static EWPreviewWire message;
  memset(&message, 0, offsetof(EWPreviewWire, json));
  message.header.msgh_bits = MACH_MSGH_BITS(MACH_MSG_TYPE_COPY_SEND, 0) | MACH_MSGH_BITS_COMPLEX;
  message.header.msgh_size = (mach_msg_size_t)(offsetof(EWPreviewWire, json) + ((length + 3) & ~(size_t)3));
  message.header.msgh_remote_port = to;
  message.header.msgh_id = WIRE_ID;
  message.body.msgh_descriptor_count = 0;
  message.length = (uint32_t)length;
  memcpy(message.json, json, length);
  memset(message.json + length, 0, ((length + 3) & ~(size_t)3) - length);
  return mach_msg(&message.header, MACH_SEND_MSG | MACH_SEND_TIMEOUT, message.header.msgh_size, 0, MACH_PORT_NULL, SEND_TIMEOUT_MS,
                  MACH_PORT_NULL) == MACH_MSG_SUCCESS;
}

static bool SendText(mach_port_t to, const char *json) { return SendWire(to, json, strlen(json)); }

static const char DISCONNECTED[] = "{\"event\":\"disconnected\"}";

/** Queue only: drops the host's right and its dead-name request. */
static void ForgetHost(void) {
  if (host == MACH_PORT_NULL) return;
  mach_port_t previous = MACH_PORT_NULL;
  if (mach_port_request_notification(mach_task_self(), host, MACH_NOTIFY_DEAD_NAME, 0, MACH_PORT_NULL, MACH_MSG_TYPE_MAKE_SEND_ONCE,
                                     &previous) == KERN_SUCCESS && previous != MACH_PORT_NULL) {
    mach_port_deallocate(mach_task_self(), previous);
  }
  mach_port_deallocate(mach_task_self(), host);
  host = MACH_PORT_NULL;
}

/** Queue only. */
static void DropPending(void) {
  for (size_t i = 0; i < pendingCount; i++) free(pending[i]);
  pendingCount = 0;
}

/** Queue only: the JS connection ends with one `disconnected`. */
static void EndStarted(void) {
  if (!started) return;
  Deliver(DISCONNECTED, strlen(DISCONNECTED), NULL, 0);
  started = false;
  connectPending = false;
  DropPending();
}

/** Queue only. `port` is the hello's send right. */
static void Hello(mach_port_t port) {
  // A hello over a live host is a new host: the old one's connection is over.
  if (host != MACH_PORT_NULL) {
    EndStarted();
    ForgetHost();
  }
  mach_port_t previous = MACH_PORT_NULL;
  if (mach_port_request_notification(mach_task_self(), port, MACH_NOTIFY_DEAD_NAME, 1, rendezvousPort, MACH_MSG_TYPE_MAKE_SEND_ONCE,
                                     &previous) != KERN_SUCCESS) {
    mach_port_deallocate(mach_task_self(), port);
    return;
  }
  if (previous != MACH_PORT_NULL) mach_port_deallocate(mach_task_self(), previous);
  host = port;
  if (started && connectPending) {
    connectPending = false;
    SendText(host, "{\"event\":\"connected\"}");
    for (size_t i = 0; i < pendingCount; i++) SendWire(host, pending[i], pendingLength[i]);
  }
  DropPending();
}

/** Queue only: the kernel's dead-name notification carries one more reference to the name. */
static void DeadName(mach_port_name_t name) {
  if (name == MACH_PORT_NULL || name != host) return;
  mach_port_type_t type = 0;
  if (mach_port_type(mach_task_self(), name, &type) != KERN_SUCCESS || !(type & MACH_PORT_TYPE_DEAD_NAME)) return;
  mach_port_deallocate(mach_task_self(), name);
  mach_port_deallocate(mach_task_self(), name);
  host = MACH_PORT_NULL;
  EndStarted();
}

/** Queue only: one received message; a dropped one has its rights destroyed. */
static void Take(EWPreviewReceive *r) {
  mach_msg_header_t *h = &r->wire.header;
  if (h->msgh_id == MACH_NOTIFY_DEAD_NAME && h->msgh_size >= offsetof(mach_dead_name_notification_t, trailer)) {
    DeadName(((mach_dead_name_notification_t *)h)->not_port);
    return;
  }
  bool complex = (h->msgh_bits & MACH_MSGH_BITS_COMPLEX) != 0;
  uint32_t count = complex ? r->wire.body.msgh_descriptor_count : 0;
  bool valid = h->msgh_id == WIRE_ID && h->msgh_size >= offsetof(EWPreviewWire, json) && count <= 1 &&
               (count == 0 || r->wire.port.type == MACH_MSG_PORT_DESCRIPTOR) && r->wire.length >= 1 && r->wire.length <= MAX_JSON &&
               h->msgh_size >= offsetof(EWPreviewWire, json) + r->wire.length;
  if (!valid) {
    mach_msg_destroy(h);
    return;
  }
  mach_port_t port = count == 1 ? r->wire.port.name : MACH_PORT_NULL;
  const char *json = r->wire.json;
  size_t length = r->wire.length;
  static const char hello[] = "{\"event\":\"hello\"}";
  if (length == strlen(hello) && memcmp(json, hello, length) == 0) {
    if (port != MACH_PORT_NULL) Hello(port);
    return;
  }
  if (!started) {
    if (port != MACH_PORT_NULL) mach_port_deallocate(mach_task_self(), port);
    return;
  }
  IOSurfaceRef surface = NULL;
  if (port != MACH_PORT_NULL) {
    surface = IOSurfaceLookupFromMachPort(port);
    mach_port_deallocate(mach_task_self(), port);
  }
  Deliver(json, length, surface, r->wire.sequence);
}

/** Queue only: everything waiting on the rendezvous port. */
static void Drain(void) {
  static EWPreviewReceive r;
  for (;;) {
    kern_return_t kr = mach_msg(&r.wire.header, MACH_RCV_MSG | MACH_RCV_TIMEOUT, 0, sizeof(r), rendezvousPort, 0, MACH_PORT_NULL);
    // Without MACH_RCV_LARGE an oversized message is dequeued and destroyed.
    if (kr == MACH_RCV_TOO_LARGE) continue;
    if (kr != MACH_MSG_SUCCESS) return;
    Take(&r);
  }
}

/** The name, checked in on the first call that succeeds; the queue and its receive source with it. */
static const char *Rendezvous(void) {
  if (!queue) queue = dispatch_queue_create("agentic-complex.preview", DISPATCH_QUEUE_SERIAL);
  if (rendezvousName[0] == 0) {
    NSString *identifier = NSBundle.mainBundle.bundleIdentifier ?: @"local.agenticcomplex.companion";
    snprintf(rendezvousName, sizeof(rendezvousName), "%s.preview.%d", identifier.UTF8String, getpid());
  }
  if (rendezvousPort == MACH_PORT_NULL) {
    mach_port_t port = MACH_PORT_NULL;
    // A failed check-in leaves the preview without a host: every send is false.
    if (bootstrap_check_in(bootstrap_port, rendezvousName, &port) != KERN_SUCCESS) return rendezvousName;
    rendezvousPort = port;
    // The default queue of 5 would make a burst (the kept sends, frames with stats) time out on both sides.
    mach_port_limits_t limits = {.mpl_qlimit = MACH_PORT_QLIMIT_LARGE};
    mach_port_set_attributes(mach_task_self(), rendezvousPort, MACH_PORT_LIMITS_INFO, (mach_port_info_t)&limits, MACH_PORT_LIMITS_INFO_COUNT);
    source = dispatch_source_create(DISPATCH_SOURCE_TYPE_MACH_RECV, rendezvousPort, 0, queue);
    dispatch_source_set_event_handler(source, ^{ Drain(); });
    dispatch_resume(source);
  }
  return rendezvousName;
}

static bool StringArg(napi_env env, napi_value value, char *out, size_t size, size_t *length) {
  napi_valuetype type;
  if (napi_typeof(env, value, &type) != napi_ok || type != napi_string) return false;
  return napi_get_value_string_utf8(env, value, out, size, length) == napi_ok;
}

// rendezvous(): string, the bootstrap name the renderer gets as --agentic-complex-preview-rendezvous; the same on every call.
static napi_value RendezvousJS(napi_env env, napi_callback_info info) {
  napi_value result;
  napi_create_string_utf8(env, Rendezvous(), NAPI_AUTO_LENGTH, &result);
  return result;
}

// start(name: string, onMessage: (json: string, surface: object | null, sequence: number) => void): name is rendezvous()'s. Drops
// any earlier connection and sends the host `connected`, or does so right after the next hello when no host has said one. The
// host's dead port, and a new host's hello, come as `{"event":"disconnected"}`.
static napi_value Start(napi_env env, napi_callback_info info) {
  size_t argc = 2;
  napi_value argv[2];
  napi_get_cb_info(env, info, &argc, argv, NULL, NULL);
  char name[512];
  size_t length = 0;
  napi_valuetype type = napi_undefined;
  if (argc == 2) napi_typeof(env, argv[1], &type);
  if (argc < 2 || !StringArg(env, argv[0], name, sizeof(name), &length) || length == 0 || type != napi_function) {
    Throw(env, "start(name, onMessage)");
    return NULL;
  }
  generation++;
  if (receiver) napi_delete_reference(env, receiver);
  napi_create_reference(env, argv[1], 1, &receiver);
  if (!tsfn) {
    napi_value resource;
    napi_create_string_utf8(env, "preview", NAPI_AUTO_LENGTH, &resource);
    napi_create_threadsafe_function(env, NULL, NULL, resource, 0, 1, NULL, NULL, NULL, CallJS, &tsfn);
    // Mach events alone must not keep Node's event loop alive.
    napi_unref_threadsafe_function(env, tsfn);
  }
  Rendezvous();
  uint64_t token = generation;
  dispatch_sync(queue, ^{
    started = true;
    startedToken = token;
    DropPending();
    connectPending = host == MACH_PORT_NULL;
    if (!connectPending) SendText(host, "{\"event\":\"connected\"}");
  });
  return NULL;
}

// send(json: string): boolean. Before the first host's hello it is kept (at most 16) and sent after `connected`. False when not
// started, over 8192 bytes, past those 16, or when the send fails.
static napi_value Send(napi_env env, napi_callback_info info) {
  size_t argc = 1;
  napi_value argv[1], result;
  napi_get_cb_info(env, info, &argc, argv, NULL, NULL);
  static char json[MAX_JSON + 2];
  size_t length = 0;
  if (argc < 1 || !StringArg(env, argv[0], json, sizeof(json), &length)) {
    Throw(env, "send(json)");
    return NULL;
  }
  __block bool sent = false;
  if (queue && length <= MAX_JSON) dispatch_sync(queue, ^{
    if (!started) return;
    if (!connectPending) { sent = SendWire(host, json, length); return; }
    if (pendingCount == MAX_PENDING) return;
    pending[pendingCount] = malloc(length);
    memcpy(pending[pendingCount], json, length);
    pendingLength[pendingCount++] = length;
    sent = true;
  });
  napi_get_boolean(env, sent, &result);
  return result;
}

// stop(): sends the host `disconnected`; nothing more of this connection reaches onMessage.
static napi_value Stop(napi_env env, napi_callback_info info) {
  generation++;
  if (queue) {
    dispatch_sync(queue, ^{
      if (started) SendText(host, DISCONNECTED);
      started = false;
      connectPending = false;
      DropPending();
    });
  }
  return NULL;
}

// mainBundle(): {identifier: string | null, path: string} of this process's main bundle.
static napi_value MainBundle(napi_env env, napi_callback_info info) {
  NSBundle *bundle = NSBundle.mainBundle;
  napi_value result, v;
  napi_create_object(env, &result);
  if (bundle.bundleIdentifier) napi_create_string_utf8(env, bundle.bundleIdentifier.UTF8String, NAPI_AUTO_LENGTH, &v);
  else napi_get_null(env, &v);
  napi_set_named_property(env, result, "identifier", v);
  napi_create_string_utf8(env, bundle.bundlePath.UTF8String, NAPI_AUTO_LENGTH, &v);
  napi_set_named_property(env, result, "path", v);
  return result;
}

// setPreventsActivation(handle: Buffer): boolean. `handle` is BrowserWindow.getNativeWindowHandle() (an NSView *); clicks in its
// window then leave the app inactive. Main thread only. False when the window does not answer the private selector.
static napi_value SetPreventsActivation(napi_env env, napi_callback_info info) {
  size_t argc = 1;
  napi_value argv[1], result;
  napi_get_cb_info(env, info, &argc, argv, NULL, NULL);
  bool isBuffer = false;
  void *data = NULL;
  size_t length = 0;
  if (argc == 1) napi_is_buffer(env, argv[0], &isBuffer);
  if (isBuffer) napi_get_buffer_info(env, argv[0], &data, &length);
  if (!isBuffer || length != sizeof(void *)) {
    Throw(env, "setPreventsActivation(nativeWindowHandle)");
    return NULL;
  }
  NSView *view = (__bridge NSView *)(*(void **)data);
  NSWindow *window = view.window;
  SEL selector = NSSelectorFromString(@"_setPreventsActivation:");
  BOOL ok = [window respondsToSelector:selector];
  if (ok) ((void (*)(id, SEL, BOOL))objc_msgSend)(window, selector, YES);
  napi_get_boolean(env, ok, &result);
  return result;
}

NAPI_MODULE_INIT() {
  const napi_property_descriptor functions[] = {
    { "rendezvous", NULL, RendezvousJS, NULL, NULL, NULL, napi_default, NULL },
    { "start", NULL, Start, NULL, NULL, NULL, napi_default, NULL },
    { "send", NULL, Send, NULL, NULL, NULL, napi_default, NULL },
    { "stop", NULL, Stop, NULL, NULL, NULL, napi_default, NULL },
    { "mainBundle", NULL, MainBundle, NULL, NULL, NULL, napi_default, NULL },
    { "setPreventsActivation", NULL, SetPreventsActivation, NULL, NULL, NULL, napi_default, NULL },
  };
  napi_define_properties(env, exports, sizeof(functions) / sizeof(functions[0]), functions);
  return exports;
}
