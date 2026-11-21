// Node-API addon for the macOS shell: the client end of the preview XPC service (C3 CONTRACT 「附录：预览 XPC」, the same wire
// as private/renderer/preview PreviewTransport.m) and `_setPreventsActivation:` for windows that must not activate the app.
// start(service, onMessage), send(json), stop(), mainBundle(), setPreventsActivation(nativeWindowHandle).
#import <AppKit/AppKit.h>
#import <IOSurface/IOSurface.h>
#import <xpc/xpc.h>
#include <node_api.h>
#include <objc/message.h>
#include <string.h>

#define MAX_JSON 8192

/** XPC events arrive on this queue; they reach JS through `tsfn`. */
static dispatch_queue_t queue;
static xpc_connection_t peer;
/** Made once and kept: an old connection's events can still be in flight when start replaces the receiver. */
static napi_threadsafe_function tsfn;
static napi_ref receiver;
/** Bumped by start and stop on the JS thread; a message of an older connection is dropped there. */
static uint64_t generation;

typedef struct {
  uint64_t token;
  char *json;
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
    napi_create_string_utf8(env, d->json, NAPI_AUTO_LENGTH, &args[0]);
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

static void Deliver(xpc_object_t message, uint64_t token) {
  Delivery *d = calloc(1, sizeof(Delivery));
  d->token = token;
  if (xpc_get_type(message) == XPC_TYPE_ERROR) {
    d->json = strdup("{\"event\":\"disconnected\"}");
  } else {
    const char *json = xpc_get_type(message) == XPC_TYPE_DICTIONARY ? xpc_dictionary_get_string(message, "json") : NULL;
    if (!json || strlen(json) > MAX_JSON) { free(d); return; }
    d->json = strdup(json);
    xpc_object_t value = xpc_dictionary_get_value(message, "surface");
    d->surface = value ? IOSurfaceLookupFromXPCObject(value) : NULL;
    d->sequence = xpc_dictionary_get_uint64(message, "sequence");
  }
  if (napi_call_threadsafe_function(tsfn, d, napi_tsfn_nonblocking) != napi_ok) {
    if (d->surface) CFRelease(d->surface);
    free(d->json);
    free(d);
  }
}

static void Cancel(void) {
  generation++;
  if (peer) {
    xpc_connection_cancel(peer);
    peer = NULL;
  }
}

static bool StringArg(napi_env env, napi_value value, char *out, size_t size, size_t *length) {
  napi_valuetype type;
  if (napi_typeof(env, value, &type) != napi_ok || type != napi_string) return false;
  return napi_get_value_string_utf8(env, value, out, size, length) == napi_ok;
}

// start(service: string, onMessage: (json: string, surface: object | null, sequence: number) => void): connects, dropping any
// earlier connection. An XPC error, a failed connection included, comes as `{"event":"disconnected"}`.
static napi_value Start(napi_env env, napi_callback_info info) {
  size_t argc = 2;
  napi_value argv[2];
  napi_get_cb_info(env, info, &argc, argv, NULL, NULL);
  char service[512];
  size_t length = 0;
  napi_valuetype type = napi_undefined;
  if (argc == 2) napi_typeof(env, argv[1], &type);
  if (argc < 2 || !StringArg(env, argv[0], service, sizeof(service), &length) || length == 0 || type != napi_function) {
    Throw(env, "start(service, onMessage)");
    return NULL;
  }
  Cancel();
  if (receiver) napi_delete_reference(env, receiver);
  napi_create_reference(env, argv[1], 1, &receiver);
  if (!tsfn) {
    napi_value name;
    napi_create_string_utf8(env, "preview", NAPI_AUTO_LENGTH, &name);
    napi_create_threadsafe_function(env, NULL, NULL, name, 0, 1, NULL, NULL, NULL, CallJS, &tsfn);
    // XPC events alone must not keep Node's event loop alive.
    napi_unref_threadsafe_function(env, tsfn);
    queue = dispatch_queue_create("agentic-complex.preview", DISPATCH_QUEUE_SERIAL);
  }
  uint64_t token = generation;
  peer = xpc_connection_create(service, queue);
  xpc_connection_set_event_handler(peer, ^(xpc_object_t message) { Deliver(message, token); });
  xpc_connection_resume(peer);
  return NULL;
}

// send(json: string): boolean. Every message expects a reply, which arrives like any other message. False without a
// connection or over 8192 bytes, which is dropped.
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
  bool sent = peer != NULL && length <= MAX_JSON;
  if (sent) {
    xpc_object_t message = xpc_dictionary_create(NULL, NULL, 0);
    xpc_dictionary_set_string(message, "json", json);
    uint64_t token = generation;
    xpc_connection_send_message_with_reply(peer, message, queue, ^(xpc_object_t reply) { Deliver(reply, token); });
  }
  napi_get_boolean(env, sent, &result);
  return result;
}

// stop(): cancels the connection; nothing more of it reaches onMessage.
static napi_value Stop(napi_env env, napi_callback_info info) {
  Cancel();
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
    { "start", NULL, Start, NULL, NULL, NULL, napi_default, NULL },
    { "send", NULL, Send, NULL, NULL, NULL, napi_default, NULL },
    { "stop", NULL, Stop, NULL, NULL, NULL, napi_default, NULL },
    { "mainBundle", NULL, MainBundle, NULL, NULL, NULL, napi_default, NULL },
    { "setPreventsActivation", NULL, SetPreventsActivation, NULL, NULL, NULL, napi_default, NULL },
  };
  napi_define_properties(env, exports, sizeof(functions) / sizeof(functions[0]), functions);
  return exports;
}
