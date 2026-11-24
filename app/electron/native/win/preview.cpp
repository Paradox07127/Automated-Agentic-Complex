// Node-API addon for the Windows shell: the named pipe of the character page's preview (C3 CONTRACT 「附录：角色页预览」
// 「Windows 传输」), the handle calls that pull a ring's shared textures out of the efw, and the DXGI adapters. Lines, hello,
// ring and frame are src/main/preview/pipe.ts's. listen(name, onData), write(connection, line), openClient(connection),
// duplicate(process, handle), close(handle), adapters().
#define WIN32_LEAN_AND_MEAN
#include <windows.h>
#include <delayimp.h>
#include <dxgi.h>
#include <sddl.h>
#include <node_api.h>
#include <stdint.h>
#include <stdio.h>
#include <string.h>
#include <string>
#include <vector>

namespace {

constexpr DWORD kPipeBuffer = 64 * 1024;
constexpr size_t kMaxLine = 8192;
constexpr DWORD kWriteTimeoutMs = 100;
// Handles go to JS as numbers.
constexpr int64_t kMaxHandle = (int64_t(1) << 53) - 1;

HANDLE pipe = INVALID_HANDLE_VALUE;
// Guards `current` and writes against the I/O thread's disconnect.
SRWLOCK lock = SRWLOCK_INIT;
// The connected client's number; 0 between connections.
uint32_t current = 0;
HANDLE writeDone = nullptr;
napi_threadsafe_function tsfn = nullptr;
napi_ref receiver = nullptr;

struct Delivery {
  uint32_t connection;
  // Empty with `end`: the connection is over.
  bool end;
  std::vector<char> bytes;
};

void Throw(napi_env env, const char* message) { napi_throw_type_error(env, nullptr, message); }

void CallJS(napi_env env, napi_value, void*, void* data) {
  Delivery* d = static_cast<Delivery*>(data);
  if (env != nullptr && receiver != nullptr) {
    napi_value callback, global, args[2];
    napi_get_reference_value(env, receiver, &callback);
    napi_create_uint32(env, d->connection, &args[0]);
    if (d->end) napi_get_null(env, &args[1]);
    else napi_create_buffer_copy(env, d->bytes.size(), d->bytes.data(), nullptr, &args[1]);
    napi_get_global(env, &global);
    napi_call_function(env, global, callback, 2, args, nullptr);
  }
  delete d;
}

void Post(uint32_t connection, const char* bytes, DWORD length) {
  Delivery* d = new Delivery{connection, bytes == nullptr, std::vector<char>(bytes, bytes + length)};
  if (napi_call_threadsafe_function(tsfn, d, napi_tsfn_blocking) != napi_ok) delete d;
}

// False on an error or EOF.
bool Wait(OVERLAPPED* o, BOOL started, DWORD* bytes) {
  if (!started && GetLastError() != ERROR_IO_PENDING) return false;
  return GetOverlappedResult(pipe, o, bytes, TRUE) != 0;
}

// The I/O thread: one connection at a time, each read handed to JS, then the next connection.
DWORD WINAPI Serve(void*) {
  HANDLE event = CreateEventW(nullptr, TRUE, FALSE, nullptr);
  std::vector<char> buffer(kPipeBuffer);
  uint32_t next = 0;
  for (;;) {
    OVERLAPPED o{};
    o.hEvent = event;
    DWORD n = 0;
    ResetEvent(event);
    BOOL connected = ConnectNamedPipe(pipe, &o);
    if (!connected && GetLastError() != ERROR_PIPE_CONNECTED && !Wait(&o, FALSE, &n)) {
      // A client that went before the connect completed; the pause keeps an unexpected error from spinning.
      DisconnectNamedPipe(pipe);
      Sleep(100);
      continue;
    }
    AcquireSRWLockExclusive(&lock);
    const uint32_t id = current = ++next;
    ReleaseSRWLockExclusive(&lock);
    for (;;) {
      OVERLAPPED r{};
      r.hEvent = event;
      DWORD got = 0;
      ResetEvent(event);
      if (!Wait(&r, ReadFile(pipe, buffer.data(), kPipeBuffer, nullptr, &r), &got)) break;
      if (got > 0) Post(id, buffer.data(), got);
    }
    AcquireSRWLockExclusive(&lock);
    current = 0;
    DisconnectNamedPipe(pipe);
    ReleaseSRWLockExclusive(&lock);
    Post(id, nullptr, 0);
  }
}

// A protected DACL with one ACE, this process's user, with all access; nullptr when it cannot be made.
PSECURITY_DESCRIPTOR OnlyUser() {
  HANDLE token = nullptr;
  if (!OpenProcessToken(GetCurrentProcess(), TOKEN_QUERY, &token)) return nullptr;
  DWORD size = 0;
  GetTokenInformation(token, TokenUser, nullptr, 0, &size);
  std::vector<BYTE> user(size);
  const bool ok = size > 0 && GetTokenInformation(token, TokenUser, user.data(), size, &size);
  CloseHandle(token);
  LPWSTR sid = nullptr;
  if (!ok || !ConvertSidToStringSidW(reinterpret_cast<TOKEN_USER*>(user.data())->User.Sid, &sid)) return nullptr;
  const std::wstring sddl = std::wstring(L"D:P(A;;GA;;;") + sid + L")";
  LocalFree(sid);
  PSECURITY_DESCRIPTOR security = nullptr;
  if (!ConvertStringSecurityDescriptorToSecurityDescriptorW(sddl.c_str(), SDDL_REVISION_1, &security, nullptr)) return nullptr;
  return security;
}

bool HandleArg(napi_env env, napi_value value, HANDLE* out) {
  int64_t v = 0;
  napi_valuetype type;
  if (napi_typeof(env, value, &type) != napi_ok || type != napi_number || napi_get_value_int64(env, value, &v) != napi_ok || v <= 0 ||
      v > kMaxHandle) {
    return false;
  }
  *out = reinterpret_cast<HANDLE>(static_cast<uintptr_t>(v));
  return true;
}

bool ConnectionArg(napi_env env, napi_value value, uint32_t* out) {
  napi_valuetype type;
  return napi_typeof(env, value, &type) == napi_ok && type == napi_number && napi_get_value_uint32(env, value, out) == napi_ok;
}

napi_value HandleValue(napi_env env, HANDLE handle) {
  napi_value result;
  if (handle == nullptr) napi_get_null(env, &result);
  else napi_create_int64(env, static_cast<int64_t>(reinterpret_cast<uintptr_t>(handle)), &result);
  return result;
}

napi_value Bool(napi_env env, bool value) {
  napi_value result;
  napi_get_boolean(env, value, &result);
  return result;
}

// listen(name: string, onData: (connection: number, data: Buffer | null) => void): boolean. Creates the pipe with
// FILE_FLAG_FIRST_PIPE_INSTANCE, one instance, byte mode, PIPE_REJECT_REMOTE_CLIENTS and D:P(A;;GA;;;<this user>), and starts the
// I/O thread; false when the pipe cannot be created. Once.
napi_value Listen(napi_env env, napi_callback_info info) {
  size_t argc = 2;
  napi_value argv[2];
  napi_get_cb_info(env, info, &argc, argv, nullptr, nullptr);
  char name[512];
  size_t length = 0;
  napi_valuetype types[2] = {napi_undefined, napi_undefined};
  for (size_t i = 0; i < argc && i < 2; i++) napi_typeof(env, argv[i], &types[i]);
  if (argc < 2 || types[0] != napi_string || types[1] != napi_function ||
      napi_get_value_string_utf8(env, argv[0], name, sizeof name, &length) != napi_ok || length == 0 || length >= sizeof name - 1) {
    Throw(env, "listen(name, onData)");
    return nullptr;
  }
  if (tsfn != nullptr) {
    Throw(env, "listen once");
    return nullptr;
  }
  wchar_t wide[512];
  const int chars = MultiByteToWideChar(CP_UTF8, MB_ERR_INVALID_CHARS, name, int(length), wide, 511);
  if (chars <= 0) return Bool(env, false);
  wide[chars] = L'\0';
  PSECURITY_DESCRIPTOR security = OnlyUser();
  if (security == nullptr) return Bool(env, false);
  SECURITY_ATTRIBUTES attributes{sizeof attributes, security, FALSE};
  pipe = CreateNamedPipeW(wide, PIPE_ACCESS_DUPLEX | FILE_FLAG_OVERLAPPED | FILE_FLAG_FIRST_PIPE_INSTANCE,
                          PIPE_TYPE_BYTE | PIPE_READMODE_BYTE | PIPE_WAIT | PIPE_REJECT_REMOTE_CLIENTS, 1, kPipeBuffer, kPipeBuffer, 0,
                          &attributes);
  LocalFree(security);
  if (pipe == INVALID_HANDLE_VALUE) return Bool(env, false);
  writeDone = CreateEventW(nullptr, TRUE, FALSE, nullptr);
  napi_create_reference(env, argv[1], 1, &receiver);
  napi_value resource;
  napi_create_string_utf8(env, "preview", NAPI_AUTO_LENGTH, &resource);
  napi_create_threadsafe_function(env, nullptr, nullptr, resource, 0, 1, nullptr, nullptr, nullptr, CallJS, &tsfn);
  // The pipe alone must not keep Node's event loop alive.
  napi_unref_threadsafe_function(env, tsfn);
  HANDLE thread = CreateThread(nullptr, 0, Serve, nullptr, 0, nullptr);
  if (thread != nullptr) CloseHandle(thread);
  return Bool(env, thread != nullptr);
}

// write(connection: number, line: string): boolean. Writes the line and a newline; false when `connection` is not the current
// one, the line is not 1-8192 bytes, or the write is not through within 100 ms.
napi_value Write(napi_env env, napi_callback_info info) {
  size_t argc = 2;
  napi_value argv[2];
  napi_get_cb_info(env, info, &argc, argv, nullptr, nullptr);
  static char line[kMaxLine + 2];
  size_t length = 0;
  uint32_t connection = 0;
  napi_valuetype type = napi_undefined;
  if (argc == 2) napi_typeof(env, argv[1], &type);
  if (argc < 2 || !ConnectionArg(env, argv[0], &connection) || type != napi_string ||
      napi_get_value_string_utf8(env, argv[1], line, sizeof line, &length) != napi_ok) {
    Throw(env, "write(connection, line)");
    return nullptr;
  }
  if (length == 0 || length > kMaxLine || memchr(line, '\n', length) != nullptr) return Bool(env, false);
  line[length] = '\n';
  const DWORD size = DWORD(length + 1);
  bool ok = false;
  AcquireSRWLockExclusive(&lock);
  if (connection != 0 && connection == current) {
    OVERLAPPED o{};
    o.hEvent = writeDone;
    ResetEvent(writeDone);
    DWORD n = 0;
    if (WriteFile(pipe, line, size, nullptr, &o) || GetLastError() == ERROR_IO_PENDING) {
      if (WaitForSingleObject(writeDone, kWriteTimeoutMs) != WAIT_OBJECT_0) CancelIoEx(pipe, &o);
      ok = GetOverlappedResult(pipe, &o, &n, TRUE) && n == size;
    }
  }
  ReleaseSRWLockExclusive(&lock);
  return Bool(env, ok);
}

// openClient(connection: number): number | null. OpenProcess(PROCESS_DUP_HANDLE) of the current connection's client.
napi_value OpenClient(napi_env env, napi_callback_info info) {
  size_t argc = 1;
  napi_value argv[1];
  napi_get_cb_info(env, info, &argc, argv, nullptr, nullptr);
  uint32_t connection = 0;
  if (argc < 1 || !ConnectionArg(env, argv[0], &connection)) {
    Throw(env, "openClient(connection)");
    return nullptr;
  }
  ULONG pid = 0;
  AcquireSRWLockShared(&lock);
  const bool ok = connection != 0 && connection == current && GetNamedPipeClientProcessId(pipe, &pid);
  ReleaseSRWLockShared(&lock);
  return HandleValue(env, ok ? OpenProcess(PROCESS_DUP_HANDLE, FALSE, pid) : nullptr);
}

// duplicate(process: number, handle: number): number | null. `handle` of `process` duplicated into this process, same access.
napi_value Duplicate(napi_env env, napi_callback_info info) {
  size_t argc = 2;
  napi_value argv[2];
  napi_get_cb_info(env, info, &argc, argv, nullptr, nullptr);
  HANDLE process = nullptr, source = nullptr;
  if (argc < 2 || !HandleArg(env, argv[0], &process) || !HandleArg(env, argv[1], &source)) {
    Throw(env, "duplicate(process, handle)");
    return nullptr;
  }
  HANDLE out = nullptr;
  if (!DuplicateHandle(process, source, GetCurrentProcess(), &out, 0, FALSE, DUPLICATE_SAME_ACCESS)) out = nullptr;
  return HandleValue(env, out);
}

// close(handle: number): CloseHandle.
napi_value Close(napi_env env, napi_callback_info info) {
  size_t argc = 1;
  napi_value argv[1];
  napi_get_cb_info(env, info, &argc, argv, nullptr, nullptr);
  HANDLE handle = nullptr;
  if (argc < 1 || !HandleArg(env, argv[0], &handle)) {
    Throw(env, "close(handle)");
    return nullptr;
  }
  CloseHandle(handle);
  return nullptr;
}

void SetNumber(napi_env env, napi_value object, const char* name, double value) {
  napi_value n;
  napi_create_double(env, value, &n);
  napi_set_named_property(env, object, name, n);
}

// adapters(): {luid: "<HighPart>:<LowPart>", vendorId, deviceId, subSysId, revision, software}[] of CreateDXGIFactory1.
napi_value Adapters(napi_env env, napi_callback_info) {
  napi_value result;
  napi_create_array(env, &result);
  IDXGIFactory1* factory = nullptr;
  if (FAILED(CreateDXGIFactory1(__uuidof(IDXGIFactory1), reinterpret_cast<void**>(&factory)))) return result;
  IDXGIAdapter1* adapter = nullptr;
  uint32_t count = 0;
  for (UINT i = 0; factory->EnumAdapters1(i, &adapter) != DXGI_ERROR_NOT_FOUND; i++) {
    DXGI_ADAPTER_DESC1 d{};
    if (SUCCEEDED(adapter->GetDesc1(&d))) {
      char luid[18];
      snprintf(luid, sizeof luid, "%08lx:%08lx", static_cast<unsigned long>(static_cast<uint32_t>(d.AdapterLuid.HighPart)),
               static_cast<unsigned long>(d.AdapterLuid.LowPart));
      napi_value item, v;
      napi_create_object(env, &item);
      napi_create_string_utf8(env, luid, NAPI_AUTO_LENGTH, &v);
      napi_set_named_property(env, item, "luid", v);
      SetNumber(env, item, "vendorId", d.VendorId);
      SetNumber(env, item, "deviceId", d.DeviceId);
      SetNumber(env, item, "subSysId", d.SubSysId);
      SetNumber(env, item, "revision", d.Revision);
      napi_set_named_property(env, item, "software", Bool(env, (d.Flags & DXGI_ADAPTER_FLAG_SOFTWARE) != 0));
      napi_set_element(env, result, count++, item);
    }
    adapter->Release();
  }
  factory->Release();
  return result;
}

// node.exe is delay-loaded (build.mjs): the Node-API symbols resolve in the process that loads the addon, Electron or Node.
FARPROC WINAPI LoadHost(unsigned event, PDelayLoadInfo info) {
  if (event != dliNotePreLoadLibrary || _stricmp(info->szDll, "node.exe") != 0) return nullptr;
  return reinterpret_cast<FARPROC>(GetModuleHandleW(nullptr));
}

}  // namespace

extern "C" const PfnDliHook __pfnDliNotifyHook2 = LoadHost;

NAPI_MODULE_INIT() {
  const napi_property_descriptor functions[] = {
    {"listen", nullptr, Listen, nullptr, nullptr, nullptr, napi_default, nullptr},
    {"write", nullptr, Write, nullptr, nullptr, nullptr, napi_default, nullptr},
    {"openClient", nullptr, OpenClient, nullptr, nullptr, nullptr, napi_default, nullptr},
    {"duplicate", nullptr, Duplicate, nullptr, nullptr, nullptr, napi_default, nullptr},
    {"close", nullptr, Close, nullptr, nullptr, nullptr, napi_default, nullptr},
    {"adapters", nullptr, Adapters, nullptr, nullptr, nullptr, napi_default, nullptr},
  };
  napi_define_properties(env, exports, sizeof functions / sizeof functions[0], functions);
  return exports;
}
