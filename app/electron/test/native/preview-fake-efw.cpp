// A stand-in efw for the Windows preview tests (preview-addon-win.test.ts, the window case of e2e-headless.test.ts), built with
// MSVC by them.
//   preview-fake-efw --agentic-complex-preview-rendezvous <pipe>: opens the pipe as efw does (every 0.5 s while it is busy), says
//     hello with the LUID of the first hardware adapter, on which it makes its D3D11 device, and prints `hello <luid>`. Each load
//     whose output differs from the ring's makes a ring of three shared BGRA textures of that output filled with one colour
//     (B 32, G 128, R 224, A 255) and sends it; then it sends a frame of the load's load_id, and the next frame on the next slot
//     16 ms after each ack of the last one. Prints each op it receives as `op <name>`; exits 0 at the pipe's end.
//   preview-fake-efw --read <pid> <handle>: duplicates <handle> out of process <pid>, opens it as a texture on that adapter and
//     prints its centre pixel as `<r>,<g>,<b>,<a>`.
#define WIN32_LEAN_AND_MEAN
#include <windows.h>
#include <d3d11_1.h>
#include <dxgi1_2.h>
#include <stdint.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <string>

namespace {

const uint32_t kColor = 0xffe08020;  // A R G B as a little-endian BGRA pixel.
constexpr int kSlots = 3;

int Fail(const char* what, long code = 0) {
  fprintf(stderr, "preview-fake-efw: %s (0x%08lx)\n", what, static_cast<unsigned long>(code));
  return 1;
}

// The first hardware adapter's device and context; false without one.
bool MakeDevice(ID3D11Device1** device, ID3D11DeviceContext** context, LUID* luid) {
  IDXGIFactory1* factory = nullptr;
  if (FAILED(CreateDXGIFactory1(__uuidof(IDXGIFactory1), reinterpret_cast<void**>(&factory)))) return false;
  IDXGIAdapter1* adapter = nullptr;
  bool ok = false;
  for (UINT i = 0; !ok && factory->EnumAdapters1(i, &adapter) != DXGI_ERROR_NOT_FOUND; i++) {
    DXGI_ADAPTER_DESC1 d{};
    if (SUCCEEDED(adapter->GetDesc1(&d)) && !(d.Flags & DXGI_ADAPTER_FLAG_SOFTWARE)) {
      ID3D11Device* base = nullptr;
      const D3D_FEATURE_LEVEL levels[] = {D3D_FEATURE_LEVEL_11_1, D3D_FEATURE_LEVEL_11_0};
      if (SUCCEEDED(D3D11CreateDevice(adapter, D3D_DRIVER_TYPE_UNKNOWN, nullptr, D3D11_CREATE_DEVICE_BGRA_SUPPORT, levels, 2,
                                      D3D11_SDK_VERSION, &base, nullptr, context))) {
        ok = SUCCEEDED(base->QueryInterface(__uuidof(ID3D11Device1), reinterpret_cast<void**>(device)));
        base->Release();
        *luid = d.AdapterLuid;
      }
    }
    adapter->Release();
  }
  factory->Release();
  return ok;
}

HANDLE pipe = INVALID_HANDLE_VALUE;

void Send(const std::string& line) {
  const std::string text = line + "\n";
  DWORD n = 0;
  WriteFile(pipe, text.data(), DWORD(text.size()), &n, nullptr);
}

// The integer after `"key":` in `json`, or `fallback`.
long long Number(const std::string& json, const char* key, long long fallback) {
  const std::string at = std::string("\"") + key + "\":";
  const size_t i = json.find(at);
  return i == std::string::npos ? fallback : _strtoi64(json.c_str() + i + at.size(), nullptr, 10);
}

struct Ring {
  int id = 0;
  UINT width = 0, height = 0;
  ID3D11Texture2D* textures[kSlots] = {};
  HANDLE handles[kSlots] = {};
  void Release() {
    for (int k = 0; k < kSlots; k++) {
      if (textures[k]) textures[k]->Release();
      if (handles[k]) CloseHandle(handles[k]);
      textures[k] = nullptr;
      handles[k] = nullptr;
    }
    width = height = 0;
  }
};

bool MakeRing(ID3D11Device1* device, Ring* ring, UINT width, UINT height) {
  ring->Release();
  ring->id++;
  ring->width = width;
  ring->height = height;
  D3D11_TEXTURE2D_DESC desc{};
  desc.Width = width;
  desc.Height = height;
  desc.MipLevels = 1;
  desc.ArraySize = 1;
  desc.Format = DXGI_FORMAT_B8G8R8A8_UNORM;
  desc.SampleDesc.Count = 1;
  desc.Usage = D3D11_USAGE_DEFAULT;
  desc.BindFlags = D3D11_BIND_SHADER_RESOURCE | D3D11_BIND_RENDER_TARGET;
  desc.MiscFlags = D3D11_RESOURCE_MISC_SHARED | D3D11_RESOURCE_MISC_SHARED_NTHANDLE;
  uint32_t* pixels = static_cast<uint32_t*>(malloc(size_t(width) * height * 4));
  for (size_t i = 0; i < size_t(width) * height; i++) pixels[i] = kColor;
  D3D11_SUBRESOURCE_DATA data{pixels, width * 4, 0};
  bool ok = true;
  for (int k = 0; k < kSlots && ok; k++) {
    IDXGIResource1* resource = nullptr;
    ok = SUCCEEDED(device->CreateTexture2D(&desc, &data, &ring->textures[k])) &&
         SUCCEEDED(ring->textures[k]->QueryInterface(__uuidof(IDXGIResource1), reinterpret_cast<void**>(&resource))) &&
         SUCCEEDED(resource->CreateSharedHandle(nullptr, DXGI_SHARED_RESOURCE_READ | DXGI_SHARED_RESOURCE_WRITE, nullptr, &ring->handles[k]));
    if (resource) resource->Release();
  }
  free(pixels);
  if (!ok) return false;
  char line[256];
  snprintf(line, sizeof line, "{\"event\":\"ring\",\"ring\":%d,\"width\":%u,\"height\":%u,\"slots\":[%llu,%llu,%llu]}", ring->id, width, height,
           static_cast<unsigned long long>(reinterpret_cast<uintptr_t>(ring->handles[0])),
           static_cast<unsigned long long>(reinterpret_cast<uintptr_t>(ring->handles[1])),
           static_cast<unsigned long long>(reinterpret_cast<uintptr_t>(ring->handles[2])));
  Send(line);
  return true;
}

// Sends frame `sequence` on its slot once the device has done its work, as efw waits for its copy.
void SendFrame(ID3D11Device1* device, ID3D11DeviceContext* context, const Ring& ring, long long sequence, long long load) {
  D3D11_QUERY_DESC q{D3D11_QUERY_EVENT, 0};
  ID3D11Query* query = nullptr;
  if (SUCCEEDED(device->CreateQuery(&q, &query))) {
    context->End(query);
    while (context->GetData(query, nullptr, 0, 0) == S_FALSE) Sleep(1);
    query->Release();
  }
  char line[256];
  snprintf(line, sizeof line, "{\"event\":\"frame\",\"sequence\":%lld,\"ring\":%d,\"slot\":%lld,\"load_id\":%lld}", sequence, ring.id,
           (sequence - 1) % kSlots, load);
  Send(line);
}

int Serve(const wchar_t* name) {
  ID3D11Device1* device = nullptr;
  ID3D11DeviceContext* context = nullptr;
  LUID luid{};
  if (!MakeDevice(&device, &context, &luid)) return Fail("no hardware D3D11 device");
  for (int tries = 0; pipe == INVALID_HANDLE_VALUE; tries++) {
    pipe = CreateFileW(name, GENERIC_READ | GENERIC_WRITE, 0, nullptr, OPEN_EXISTING, 0, nullptr);
    if (pipe == INVALID_HANDLE_VALUE && (GetLastError() != ERROR_PIPE_BUSY || tries == 60)) return Fail("pipe", long(GetLastError()));
    if (pipe == INVALID_HANDLE_VALUE) Sleep(500);
  }
  char hello[96];
  snprintf(hello, sizeof hello, "%08lx:%08lx", static_cast<unsigned long>(static_cast<uint32_t>(luid.HighPart)),
           static_cast<unsigned long>(luid.LowPart));
  Send(std::string("{\"event\":\"hello\",\"luid\":\"") + hello + "\"}");
  printf("hello %s\n", hello);
  fflush(stdout);
  Ring ring;
  long long load = 0, sequence = 0;
  std::string pending;
  char buffer[65536];
  for (;;) {
    DWORD n = 0;
    if (!ReadFile(pipe, buffer, sizeof buffer, &n, nullptr) || n == 0) break;
    pending.append(buffer, n);
    for (size_t end; (end = pending.find('\n')) != std::string::npos; pending.erase(0, end + 1)) {
      const std::string line = pending.substr(0, end);
      const size_t op = line.find("\"op\":\"");
      const size_t event = line.find("\"event\":\"");
      const size_t at = op != std::string::npos ? op + 6 : event != std::string::npos ? event + 9 : std::string::npos;
      const std::string what = at == std::string::npos ? "?" : line.substr(at, line.find('"', at) - at);
      printf("op %s\n", what.c_str());
      fflush(stdout);
      if (what == "load") {
        load = Number(line, "load_id", 0);
        const size_t output = line.find("\"output\":[");
        UINT width = 480, height = 576;
        if (output != std::string::npos) {
          char* next = nullptr;
          width = UINT(strtoul(line.c_str() + output + 10, &next, 10));
          height = UINT(strtoul(next + 1, nullptr, 10));
        }
        if ((width != ring.width || height != ring.height) && !MakeRing(device, &ring, width, height)) return Fail("ring");
        SendFrame(device, context, ring, ++sequence, load);
      } else if (what == "ack" && ring.width != 0 && Number(line, "sequence", -1) == sequence) {
        Sleep(16);
        SendFrame(device, context, ring, ++sequence, load);
      } else if (what == "disconnected") {
        ring.Release();
      }
    }
  }
  ring.Release();
  return 0;
}

int Read(DWORD pid, HANDLE source) {
  ID3D11Device1* device = nullptr;
  ID3D11DeviceContext* context = nullptr;
  LUID luid{};
  if (!MakeDevice(&device, &context, &luid)) return Fail("no hardware D3D11 device");
  HANDLE process = OpenProcess(PROCESS_DUP_HANDLE, FALSE, pid);
  HANDLE handle = nullptr;
  if (!process || !DuplicateHandle(process, source, GetCurrentProcess(), &handle, 0, FALSE, DUPLICATE_SAME_ACCESS)) {
    return Fail("duplicate", long(GetLastError()));
  }
  ID3D11Texture2D* texture = nullptr;
  HRESULT hr = device->OpenSharedResource1(handle, __uuidof(ID3D11Texture2D), reinterpret_cast<void**>(&texture));
  if (FAILED(hr)) return Fail("open shared resource", hr);
  D3D11_TEXTURE2D_DESC desc{};
  texture->GetDesc(&desc);
  desc.Usage = D3D11_USAGE_STAGING;
  desc.BindFlags = 0;
  desc.MiscFlags = 0;
  desc.CPUAccessFlags = D3D11_CPU_ACCESS_READ;
  ID3D11Texture2D* staging = nullptr;
  if (FAILED(hr = device->CreateTexture2D(&desc, nullptr, &staging))) return Fail("staging", hr);
  context->CopyResource(staging, texture);
  D3D11_MAPPED_SUBRESOURCE map{};
  if (FAILED(hr = context->Map(staging, 0, D3D11_MAP_READ, 0, &map))) return Fail("map", hr);
  const uint8_t* p = static_cast<const uint8_t*>(map.pData) + size_t(desc.Height / 2) * map.RowPitch + size_t(desc.Width / 2) * 4;
  printf("%u,%u,%u,%u\n", p[2], p[1], p[0], p[3]);
  context->Unmap(staging, 0);
  return 0;
}

}  // namespace

int wmain(int argc, wchar_t** argv) {
  if (argc == 3 && wcscmp(argv[1], L"--agentic-complex-preview-rendezvous") == 0) return Serve(argv[2]);
  if (argc == 4 && wcscmp(argv[1], L"--read") == 0) {
    return Read(DWORD(wcstoul(argv[2], nullptr, 10)), reinterpret_cast<HANDLE>(static_cast<uintptr_t>(_wcstoui64(argv[3], nullptr, 10))));
  }
  return Fail("usage: --agentic-complex-preview-rendezvous <pipe> | --read <pid> <handle>");
}
