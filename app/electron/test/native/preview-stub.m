// A stand-in renderer for the window test, launched by preview-harness.ts with `--agentic-complex-preview-rendezvous <name>`: speaks
// the character page preview's Mach wire and draws nothing. Every frame carries the same 256x256 BGRA IOSurface of a known
// gradient: pixel (x, y) is R = 255 - x, G = y, B = x, A = 255. Exits on `disconnected`, or after 60 s without a message.
#import <Foundation/Foundation.h>
#import <IOSurface/IOSurface.h>
#include <bootstrap.h>
#include <mach/mach.h>
#include <stddef.h>

typedef struct {
  mach_msg_header_t header;
  mach_msg_body_t body;
  mach_msg_port_descriptor_t port;
  uint64_t sequence;
  uint32_t length;
  char json[8192];
} EWPreviewWire;

static mach_port_t server, own;
static IOSurfaceRef surface;
static uint64_t sequence, loadID;

static IOSurfaceRef Gradient(void) {
  NSDictionary *props = @{ (id)kIOSurfaceWidth: @256, (id)kIOSurfaceHeight: @256, (id)kIOSurfaceBytesPerElement: @4,
                           (id)kIOSurfacePixelFormat: @0x42475241 };
  IOSurfaceRef s = IOSurfaceCreate((__bridge CFDictionaryRef)props);
  IOSurfaceLock(s, 0, NULL);
  uint8_t *base = IOSurfaceGetBaseAddress(s);
  size_t row = IOSurfaceGetBytesPerRow(s);
  for (int y = 0; y < 256; y++) {
    for (int x = 0; x < 256; x++) {
      uint8_t *p = base + y * row + x * 4;
      p[0] = x; p[1] = y; p[2] = 255 - x; p[3] = 255;
    }
  }
  IOSurfaceUnlock(s, 0, NULL);
  return s;
}

static void Send(NSString *json, mach_port_t port, mach_msg_type_name_t disposition, uint64_t seq) {
  static EWPreviewWire m;
  const char *text = json.UTF8String;
  size_t length = strlen(text);
  memset(&m, 0, sizeof m);
  m.header.msgh_bits = MACH_MSGH_BITS(MACH_MSG_TYPE_COPY_SEND, 0) | MACH_MSGH_BITS_COMPLEX;
  m.header.msgh_size = (mach_msg_size_t)(offsetof(EWPreviewWire, json) + ((length + 3) & ~(size_t)3));
  m.header.msgh_remote_port = server;
  m.header.msgh_id = 0x45575056;
  m.body.msgh_descriptor_count = port != MACH_PORT_NULL;
  m.port.name = port;
  m.port.disposition = disposition;
  m.port.type = MACH_MSG_PORT_DESCRIPTOR;
  m.sequence = seq;
  m.length = (uint32_t)length;
  memcpy(m.json, text, length);
  mach_msg(&m.header, MACH_SEND_MSG | MACH_SEND_TIMEOUT, m.header.msgh_size, 0, MACH_PORT_NULL, 100, MACH_PORT_NULL);
}

static void Frame(void) {
  Send([NSString stringWithFormat:@"{\"event\":\"frame\",\"load_id\":%llu}", loadID], IOSurfaceCreateMachPort(surface),
       MACH_MSG_TYPE_MOVE_SEND, ++sequence);
}

int main(int argc, char **argv) {
  const char *name = NULL;
  for (int i = 1; i + 1 < argc; i++) if (strcmp(argv[i], "--agentic-complex-preview-rendezvous") == 0) name = argv[i + 1];
  if (!name || bootstrap_look_up(bootstrap_port, name, &server) != KERN_SUCCESS) return 2;
  surface = Gradient();
  mach_port_allocate(mach_task_self(), MACH_PORT_RIGHT_RECEIVE, &own);
  Send(@"{\"event\":\"hello\"}", own, MACH_MSG_TYPE_MAKE_SEND, 0);
  static struct { EWPreviewWire wire; mach_msg_trailer_t trailer; } r;
  for (;;) {
    if (mach_msg(&r.wire.header, MACH_RCV_MSG | MACH_RCV_TIMEOUT, 0, sizeof r, own, 60000, MACH_PORT_NULL) != KERN_SUCCESS) return 3;
    if (r.wire.length == 0 || r.wire.length > 8192) continue;
    NSDictionary *m = [NSJSONSerialization JSONObjectWithData:[NSData dataWithBytes:r.wire.json length:r.wire.length] options:0 error:nil];
    if (![m isKindOfClass:NSDictionary.class]) continue;
    if ([m[@"event"] isEqual:@"disconnected"]) return 0;
    NSString *op = m[@"op"];
    if ([op isEqual:@"load"] || [op isEqual:@"sequence"]) {
      loadID = [m[@"load_id"] unsignedLongLongValue];
      NSString *clip = [op isEqual:@"load"] ? (m[@"clip"] ?: @"idle") : [m[@"clips"] firstObject];
      Send([NSString stringWithFormat:@"{\"event\":\"loaded\",\"load_id\":%llu,\"character\":\"%@\",\"clip\":\"%@\"}", loadID,
            m[@"character"] ?: @"stub", clip], MACH_PORT_NULL, 0, 0);
      Frame();
    } else if ([op isEqual:@"ack"] || [op isEqual:@"resume"]) {
      usleep(50 * 1000);
      Frame();
    }
  }
}
