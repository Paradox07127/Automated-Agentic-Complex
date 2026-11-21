// A stand-in preview XPC service for the window test: speaks the wire of C3 CONTRACT 「附录：预览 XPC」 and draws nothing. Every
// frame carries the same 256x256 BGRA IOSurface of a known gradient: pixel (x, y) is R = 255 - x, G = y, B = x, A = 255.
#import <Foundation/Foundation.h>
#import <IOSurface/IOSurface.h>
#import <xpc/xpc.h>

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

static void Reply(xpc_connection_t peer, xpc_object_t request, NSString *json, BOOL frame) {
  xpc_object_t reply = xpc_dictionary_create_reply(request);
  if (!reply) return;
  xpc_dictionary_set_string(reply, "json", json.UTF8String);
  if (frame) {
    xpc_dictionary_set_uint64(reply, "sequence", ++sequence);
    xpc_dictionary_set_value(reply, "surface", IOSurfaceCreateXPCObject(surface));
  }
  xpc_connection_send_message(peer, reply);
}

static void Send(xpc_connection_t peer, NSString *json) {
  xpc_object_t message = xpc_dictionary_create(NULL, NULL, 0);
  xpc_dictionary_set_string(message, "json", json.UTF8String);
  xpc_connection_send_message(peer, message);
}

static void Answer(xpc_connection_t peer, xpc_object_t message) {
  if (xpc_get_type(message) != XPC_TYPE_DICTIONARY) return;
  const char *text = xpc_dictionary_get_string(message, "json");
  if (!text) return;
  NSDictionary *r = [NSJSONSerialization JSONObjectWithData:[NSData dataWithBytes:text length:strlen(text)] options:0 error:nil];
  NSString *op = [r isKindOfClass:NSDictionary.class] ? r[@"op"] : nil;
  NSString *frame = nil;
  if ([op isEqual:@"load"] || [op isEqual:@"sequence"]) {
    loadID = [r[@"load_id"] unsignedLongLongValue];
    NSString *clip = [op isEqual:@"load"] ? (r[@"clip"] ?: @"idle") : [r[@"clips"] firstObject];
    Send(peer, [NSString stringWithFormat:@"{\"event\":\"loaded\",\"load_id\":%llu,\"character\":\"%@\",\"clip\":\"%@\"}", loadID,
                r[@"character"] ?: @"stub", clip]);
    frame = [NSString stringWithFormat:@"{\"event\":\"frame\",\"load_id\":%llu}", loadID];
    Reply(peer, message, frame, YES);
  } else if ([op isEqual:@"ack"] || [op isEqual:@"resume"]) {
    frame = [NSString stringWithFormat:@"{\"event\":\"frame\",\"load_id\":%llu}", loadID];
    dispatch_after(dispatch_time(DISPATCH_TIME_NOW, 50 * NSEC_PER_MSEC), dispatch_get_main_queue(), ^{ Reply(peer, message, frame, YES); });
  } else {
    Reply(peer, message, @"{\"event\":\"accepted\"}", NO);
  }
}

static void Accept(xpc_connection_t peer) {
  xpc_connection_set_target_queue(peer, dispatch_get_main_queue());
  xpc_connection_set_event_handler(peer, ^(xpc_object_t message) {
    if (xpc_get_type(message) == XPC_TYPE_ERROR) {
      dispatch_after(dispatch_time(DISPATCH_TIME_NOW, 250 * NSEC_PER_MSEC), dispatch_get_main_queue(), ^{ exit(0); });
      return;
    }
    Answer(peer, message);
  });
  xpc_connection_resume(peer);
}

int main(void) {
  surface = Gradient();
  xpc_main(Accept);
}
