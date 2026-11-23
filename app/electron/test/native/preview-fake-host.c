// A stand-in renderer for preview-addon.test.ts: the host end of the preview's Mach rendezvous (native/mac/preview.m). Looks up
// argv[1], says hello with its own port and prints `hello`. On `connected` it sends `{"event":"greeting","surface":<id>}` and one
// frame (sequence 7) of a 64x32 IOSurface; every JSON it receives comes back as `{"event":"echo","length":N[,"of":<json>]}`; on
// `disconnected` it prints `disconnected` and exits 0. Exits 3 after 20 s without a message.
#include <IOSurface/IOSurface.h>
#include <bootstrap.h>
#include <mach/mach.h>
#include <stddef.h>
#include <stdio.h>
#include <string.h>

typedef struct {
  mach_msg_header_t header;
  mach_msg_body_t body;
  mach_msg_port_descriptor_t port;
  uint64_t sequence;
  uint32_t length;
  char json[8192];
} EWPreviewWire;

static mach_port_t server, own;

static kern_return_t Send(const char *json, mach_port_t port, mach_msg_type_name_t disposition, uint64_t sequence) {
  static EWPreviewWire m;
  size_t length = strlen(json);
  memset(&m, 0, sizeof m);
  m.header.msgh_bits = MACH_MSGH_BITS(MACH_MSG_TYPE_COPY_SEND, 0) | MACH_MSGH_BITS_COMPLEX;
  m.header.msgh_size = (mach_msg_size_t)(offsetof(EWPreviewWire, json) + ((length + 3) & ~(size_t)3));
  m.header.msgh_remote_port = server;
  m.header.msgh_id = 0x45575056;
  m.body.msgh_descriptor_count = port != MACH_PORT_NULL;
  m.port.name = port;
  m.port.disposition = disposition;
  m.port.type = MACH_MSG_PORT_DESCRIPTOR;
  m.sequence = sequence;
  m.length = (uint32_t)length;
  memcpy(m.json, json, length);
  return mach_msg(&m.header, MACH_SEND_MSG | MACH_SEND_TIMEOUT, m.header.msgh_size, 0, MACH_PORT_NULL, 100, MACH_PORT_NULL);
}

static IOSurfaceRef Surface(void) {
  int w = 64, h = 32, bpe = 4;
  CFNumberRef W = CFNumberCreate(0, kCFNumberIntType, &w), H = CFNumberCreate(0, kCFNumberIntType, &h),
              B = CFNumberCreate(0, kCFNumberIntType, &bpe);
  const void *k[] = { kIOSurfaceWidth, kIOSurfaceHeight, kIOSurfaceBytesPerElement }, *v[] = { W, H, B };
  CFDictionaryRef d = CFDictionaryCreate(0, k, v, 3, &kCFTypeDictionaryKeyCallBacks, &kCFTypeDictionaryValueCallBacks);
  return IOSurfaceCreate(d);
}

int main(int argc, char **argv) {
  if (argc < 2 || bootstrap_look_up(bootstrap_port, argv[1], &server) != KERN_SUCCESS) return 2;
  mach_port_allocate(mach_task_self(), MACH_PORT_RIGHT_RECEIVE, &own);
  // As PreviewTransport.m does for the real host's port.
  mach_port_limits_t limits = {.mpl_qlimit = MACH_PORT_QLIMIT_LARGE};
  mach_port_set_attributes(mach_task_self(), own, MACH_PORT_LIMITS_INFO, (mach_port_info_t)&limits, MACH_PORT_LIMITS_INFO_COUNT);
  if (Send("{\"event\":\"hello\"}", own, MACH_MSG_TYPE_MAKE_SEND, 0) != KERN_SUCCESS) return 2;
  printf("hello\n");
  fflush(stdout);
  IOSurfaceRef surface = Surface();
  static struct { EWPreviewWire wire; mach_msg_trailer_t trailer; } r;
  static char text[8193], reply[8192];
  for (;;) {
    if (mach_msg(&r.wire.header, MACH_RCV_MSG | MACH_RCV_TIMEOUT, 0, sizeof r, own, 20000, MACH_PORT_NULL) != KERN_SUCCESS) return 3;
    size_t length = r.wire.length > 8192 ? 8192 : r.wire.length;
    memcpy(text, r.wire.json, length);
    text[length] = 0;
    int n = snprintf(reply, sizeof reply, "{\"event\":\"echo\",\"length\":%zu,\"of\":%s}", length, text);
    if (n < 0 || (size_t)n >= sizeof reply) snprintf(reply, sizeof reply, "{\"event\":\"echo\",\"length\":%zu}", length);
    Send(reply, MACH_PORT_NULL, 0, 0);
    if (strcmp(text, "{\"event\":\"disconnected\"}") == 0) {
      printf("disconnected\n");
      return 0;
    }
    if (strcmp(text, "{\"event\":\"connected\"}") == 0) {
      snprintf(reply, sizeof reply, "{\"event\":\"greeting\",\"surface\":%u}", IOSurfaceGetID(surface));
      Send(reply, MACH_PORT_NULL, 0, 0);
      Send("{\"event\":\"frame\",\"load_id\":1}", IOSurfaceCreateMachPort(surface), MACH_MSG_TYPE_MOVE_SEND, 7);
    }
  }
}
