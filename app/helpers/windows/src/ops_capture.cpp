// The capture ops. capture.window takes one frame of the window through Windows.Graphics.Capture;
// capture.ambient takes one frame of the display with another process's windows left out (the display session's
// window exclusion list), or decodes the wallpaper file. WIC scales and encodes; no pixel leaves the process except
// in the answer.
#define NOMINMAX
#include <windows.h>
#include <d3d11.h>
#include <dxgi.h>
#include <inspectable.h>
#include <roapi.h>
#include <shobjidl.h>
#include <wincodec.h>
#include <windows.foundation.h>
#include <windows.graphics.capture.h>
#include <windows.graphics.capture.interop.h>
#include <windows.graphics.directx.direct3d11.interop.h>
#include <wrl/client.h>
#include <wrl/ftm.h>
#include <wrl/implements.h>
#include <wrl/wrappers/corewrappers.h>

#include <algorithm>
#include <cmath>
#include <cstdint>
#include <set>
#include <string>
#include <utility>
#include <vector>

#include "json.h"
#include "ops.h"
#include "win32.h"

namespace {

using Microsoft::WRL::ComPtr;
using Microsoft::WRL::Wrappers::HStringReference;
namespace wgc = ABI::Windows::Graphics::Capture;

constexpr ULONGLONG kFrameWaitMs = 2000;  // inside capture.window's timeout_ms of 5000
// capture.window's max_bytes when the request gives none: base64 of it leaves 64 KiB of max_line_bytes for the rest.
constexpr int64_t kDefaultMaxBytes = (16777216 - 65536) / 4 * 3;
constexpr const char* kNoExclusion = "window exclusion unavailable";

// The SDK headers lack IDisplayGraphicsCaptureSession and IDirect3D11CaptureFrame3, so these declare them with the
// metadata's IIDs and the collections of WindowId with the IIDs derived for them; a Windows.UI.WindowId travels as its
// one UINT64 field, the HWND.
MIDL_INTERFACE("ba0a30a1-c082-5671-ac07-7aaa4f269670")  // IIterator<Windows.UI.WindowId>
IWindowIdIterator : public IInspectable {
    virtual HRESULT STDMETHODCALLTYPE get_Current(UINT64* current) = 0;
    virtual HRESULT STDMETHODCALLTYPE get_HasCurrent(boolean* has) = 0;
    virtual HRESULT STDMETHODCALLTYPE MoveNext(boolean* has) = 0;
    virtual HRESULT STDMETHODCALLTYPE GetMany(UINT32 capacity, UINT64* items, UINT32* actual) = 0;
};
MIDL_INTERFACE("745698bf-22ad-5c0d-b0e0-07d35a1c9719")  // IIterable<Windows.UI.WindowId>
IWindowIdIterable : public IInspectable {
    virtual HRESULT STDMETHODCALLTYPE First(IWindowIdIterator** first) = 0;
};
MIDL_INTERFACE("bb91f61b-218a-587d-8580-2701a74c0525")
IDisplayGraphicsCaptureSession : public IInspectable {
    virtual HRESULT STDMETHODCALLTYPE SetWindowExclusionList(IWindowIdIterable* windows, UINT64* iteration) = 0;
    virtual HRESULT STDMETHODCALLTYPE GetWindowExclusionList(IInspectable** windows) = 0;
};
MIDL_INTERFACE("71616dc8-fea5-5741-a3d8-591acc39a9ee")
IDirect3D11CaptureFrame3 : public IInspectable {
    virtual HRESULT STDMETHODCALLTYPE get_ConfigurationIteration(UINT64* iteration) = 0;
};

class WindowIdCursor
    : public Microsoft::WRL::RuntimeClass<Microsoft::WRL::RuntimeClassFlags<Microsoft::WRL::WinRt>, IWindowIdIterator,
                                          Microsoft::WRL::FtmBase> {
    InspectableClass(L"Windows.Foundation.Collections.IIterator`1<Windows.UI.WindowId>", BaseTrust)

public:
    explicit WindowIdCursor(std::vector<UINT64> ids) : ids_(std::move(ids)) {}
    IFACEMETHODIMP get_Current(UINT64* current) override {
        if (at_ >= ids_.size()) return E_BOUNDS;
        *current = ids_[at_];
        return S_OK;
    }
    IFACEMETHODIMP get_HasCurrent(boolean* has) override {
        *has = at_ < ids_.size();
        return S_OK;
    }
    IFACEMETHODIMP MoveNext(boolean* has) override {
        if (at_ < ids_.size()) ++at_;
        return get_HasCurrent(has);
    }
    IFACEMETHODIMP GetMany(UINT32 capacity, UINT64* items, UINT32* actual) override {
        UINT32 n = 0;
        while (n < capacity && at_ < ids_.size()) items[n++] = ids_[at_++];
        *actual = n;
        return S_OK;
    }

private:
    std::vector<UINT64> ids_;
    size_t at_ = 0;
};

class WindowIds
    : public Microsoft::WRL::RuntimeClass<Microsoft::WRL::RuntimeClassFlags<Microsoft::WRL::WinRt>, IWindowIdIterable,
                                          Microsoft::WRL::FtmBase> {
    InspectableClass(L"Windows.Foundation.Collections.IIterable`1<Windows.UI.WindowId>", BaseTrust)

public:
    explicit WindowIds(std::vector<UINT64> ids) : ids_(std::move(ids)) {}
    IFACEMETHODIMP First(IWindowIdIterator** first) override {
        ComPtr<WindowIdCursor> cursor = Microsoft::WRL::Make<WindowIdCursor>(ids_);
        *first = cursor.Detach();
        return *first ? S_OK : E_OUTOFMEMORY;
    }

private:
    std::vector<UINT64> ids_;
};

// COM for one op thread, joined to the multithreaded apartment; declare it before the objects it outlives.
class Com {
public:
    Com() : hr_(CoInitializeEx(nullptr, COINIT_MULTITHREADED)) {}
    ~Com() {
        if (SUCCEEDED(hr_)) CoUninitialize();
    }
    Com(const Com&) = delete;
    Com& operator=(const Com&) = delete;

private:
    HRESULT hr_;
};

// Closes a capture object when it goes out of scope, which stops the capture at once.
struct Closing {
    ComPtr<IUnknown> object;
    ~Closing() {
        ComPtr<ABI::Windows::Foundation::IClosable> closable;
        if (object && SUCCEEDED(object.As(&closable))) closable->Close();
    }
};

// Top-down 32-bit pixels, width * 4 bytes a row.
struct Pixels {
    UINT width = 0, height = 0;
    std::vector<BYTE> data;
};

std::string base64(const std::vector<BYTE>& bytes) {
    static const char digits[] = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
    std::string out;
    out.reserve((bytes.size() + 2) / 3 * 4);
    for (size_t i = 0; i < bytes.size(); i += 3) {
        uint32_t chunk = static_cast<uint32_t>(bytes[i]) << 16;
        if (i + 1 < bytes.size()) chunk |= static_cast<uint32_t>(bytes[i + 1]) << 8;
        if (i + 2 < bytes.size()) chunk |= bytes[i + 2];
        out += digits[(chunk >> 18) & 63];
        out += digits[(chunk >> 12) & 63];
        out += i + 1 < bytes.size() ? digits[(chunk >> 6) & 63] : '=';
        out += i + 2 < bytes.size() ? digits[chunk & 63] : '=';
    }
    return out;
}

ComPtr<IWICImagingFactory> wic_factory() {
    ComPtr<IWICImagingFactory> factory;
    CoCreateInstance(CLSID_WICImagingFactory, nullptr, CLSCTX_INPROC_SERVER, IID_PPV_ARGS(&factory));
    return factory;
}

// source as premultiplied BGRA, scaled to width x height (Fant) when its size differs.
bool fit(IWICImagingFactory* factory, IWICBitmapSource* source, UINT width, UINT height, Pixels& out) {
    ComPtr<IWICFormatConverter> converter;
    if (FAILED(factory->CreateFormatConverter(&converter)) ||
        FAILED(converter->Initialize(source, GUID_WICPixelFormat32bppPBGRA, WICBitmapDitherTypeNone, nullptr, 0,
                                     WICBitmapPaletteTypeCustom))) {
        return false;
    }
    ComPtr<IWICBitmapSource> sized = converter;
    UINT w = 0, h = 0;
    if (FAILED(converter->GetSize(&w, &h))) return false;
    if (w != width || h != height) {
        ComPtr<IWICBitmapScaler> scaler;
        if (FAILED(factory->CreateBitmapScaler(&scaler)) ||
            FAILED(scaler->Initialize(converter.Get(), width, height, WICBitmapInterpolationModeFant))) {
            return false;
        }
        sized = scaler;
    }
    out.width = width;
    out.height = height;
    out.data.resize(static_cast<size_t>(width) * height * 4);
    return SUCCEEDED(sized->CopyPixels(nullptr, width * 4, static_cast<UINT>(out.data.size()), out.data.data()));
}

// Premultiplied BGRA as PNG (straight BGRA) or JPEG (quality 0.8, transparency over white).
bool encode(IWICImagingFactory* factory, const Pixels& pixels, bool jpeg, std::vector<BYTE>& bytes) {
    size_t count = static_cast<size_t>(pixels.width) * pixels.height;
    std::vector<BYTE> data(count * (jpeg ? 3 : 4));
    for (size_t p = 0; p < count; ++p) {
        const BYTE* in = &pixels.data[p * 4];
        BYTE alpha = in[3];
        if (jpeg) {
            for (int c = 0; c < 3; ++c) data[p * 3 + c] = static_cast<BYTE>(std::min(255, in[c] + 255 - alpha));
        } else {
            for (int c = 0; c < 3; ++c) {
                data[p * 4 + c] = static_cast<BYTE>(alpha ? std::min(255, (in[c] * 255 + alpha / 2) / alpha) : 0);
            }
            data[p * 4 + 3] = alpha;
        }
    }
    WICPixelFormatGUID format = jpeg ? GUID_WICPixelFormat24bppBGR : GUID_WICPixelFormat32bppBGRA, given = format;
    UINT stride = pixels.width * (jpeg ? 3 : 4);
    ComPtr<IStream> stream;
    ComPtr<IWICBitmapEncoder> encoder;
    ComPtr<IWICBitmapFrameEncode> frame;
    ComPtr<IPropertyBag2> options;
    if (FAILED(CreateStreamOnHGlobal(nullptr, TRUE, &stream)) ||
        FAILED(factory->CreateEncoder(jpeg ? GUID_ContainerFormatJpeg : GUID_ContainerFormatPng, nullptr, &encoder)) ||
        FAILED(encoder->Initialize(stream.Get(), WICBitmapEncoderNoCache)) ||
        FAILED(encoder->CreateNewFrame(&frame, &options))) {
        return false;
    }
    if (jpeg) {
        PROPBAG2 option{};
        option.pstrName = const_cast<LPOLESTR>(L"ImageQuality");
        VARIANT quality{};
        quality.vt = VT_R4;
        quality.fltVal = 0.8f;
        if (FAILED(options->Write(1, &option, &quality))) return false;
    }
    if (FAILED(frame->Initialize(options.Get())) || FAILED(frame->SetSize(pixels.width, pixels.height)) ||
        FAILED(frame->SetPixelFormat(&given)) || given != format ||
        FAILED(frame->WritePixels(pixels.height, stride, static_cast<UINT>(data.size()), data.data())) ||
        FAILED(frame->Commit()) || FAILED(encoder->Commit())) {
        return false;
    }
    STATSTG stat{};
    HGLOBAL memory = nullptr;
    if (FAILED(stream->Stat(&stat, STATFLAG_NONAME)) || FAILED(GetHGlobalFromStream(stream.Get(), &memory))) return false;
    const BYTE* encoded = static_cast<const BYTE*>(GlobalLock(memory));
    if (!encoded) return false;
    bytes.assign(encoded, encoded + stat.cbSize.QuadPart);
    GlobalUnlock(memory);
    return true;
}

// One frame of item (size big) without the cursor, premultiplied BGRA, cut to crop (frame pixels) when given. excluded,
// when given, is left out through the display session's exclusion list; empty on success, else why not (kNoExclusion
// when this Windows cannot leave windows out).
std::string grab_item(wgc::IGraphicsCaptureItem* item, ABI::Windows::Graphics::SizeInt32 size,
                      const std::vector<HWND>* excluded, const RECT* crop, Pixels& out) {
    ComPtr<ID3D11Device> device;
    ComPtr<ID3D11DeviceContext> context;
    ComPtr<IDXGIDevice> dxgi;
    ComPtr<IInspectable> inspectable;
    ComPtr<ABI::Windows::Graphics::DirectX::Direct3D11::IDirect3DDevice> direct3d;
    if (FAILED(D3D11CreateDevice(nullptr, D3D_DRIVER_TYPE_HARDWARE, nullptr, D3D11_CREATE_DEVICE_BGRA_SUPPORT, nullptr,
                                 0, D3D11_SDK_VERSION, &device, nullptr, &context)) ||
        FAILED(device.As(&dxgi)) || FAILED(CreateDirect3D11DeviceFromDXGIDevice(dxgi.Get(), &inspectable)) ||
        FAILED(inspectable.As(&direct3d))) {
        return "no Direct3D 11 device for Windows.Graphics.Capture";
    }
    ComPtr<wgc::IDirect3D11CaptureFramePoolStatics2> pools;
    ComPtr<wgc::IDirect3D11CaptureFramePool> pool;
    ComPtr<wgc::IGraphicsCaptureSession> session;
    Closing pool_closing, session_closing;
    if (FAILED(RoGetActivationFactory(
            HStringReference(RuntimeClass_Windows_Graphics_Capture_Direct3D11CaptureFramePool).Get(),
            IID_PPV_ARGS(&pools))) ||
        FAILED(pools->CreateFreeThreaded(
            direct3d.Get(),
            ABI::Windows::Graphics::DirectX::DirectXPixelFormat::DirectXPixelFormat_B8G8R8A8UIntNormalized, 1, size,
            &pool))) {
        return "cannot create a capture frame pool";
    }
    pool_closing.object = pool;
    if (FAILED(pool->CreateCaptureSession(item, &session))) return "cannot create a capture session";
    session_closing.object = session;
    ComPtr<wgc::IGraphicsCaptureSession2> cursor;
    if (SUCCEEDED(session.As(&cursor))) cursor->put_IsCursorCaptureEnabled(false);
    // Where the OS lacks IsBorderRequired or refuses it, the yellow border stays.
    ComPtr<wgc::IGraphicsCaptureSession3> border;
    if (SUCCEEDED(session.As(&border))) border->put_IsBorderRequired(false);
    UINT64 iteration = 0;
    if (excluded) {
        std::vector<UINT64> ids;
        for (HWND hwnd : *excluded) ids.push_back(static_cast<UINT64>(reinterpret_cast<uintptr_t>(hwnd)));
        ComPtr<WindowIds> list = Microsoft::WRL::Make<WindowIds>(std::move(ids));
        ComPtr<IDisplayGraphicsCaptureSession> display;
        if (!list || FAILED(session.As(&display)) || FAILED(display->SetWindowExclusionList(list.Get(), &iteration))) {
            return kNoExclusion;
        }
    }
    if (FAILED(session->StartCapture())) return "the capture session did not start";
    // A frame composed before the exclusion list took effect still shows the excluded windows.
    auto usable = [&](wgc::IDirect3D11CaptureFrame* frame) {
        ComPtr<IDirect3D11CaptureFrame3> configured;
        UINT64 at = 0;
        return !excluded || (SUCCEEDED(frame->QueryInterface(IID_PPV_ARGS(&configured))) &&
                             SUCCEEDED(configured->get_ConfigurationIteration(&at)) && at >= iteration);
    };
    ComPtr<wgc::IDirect3D11CaptureFrame> frame;
    ULONGLONG until = GetTickCount64() + kFrameWaitMs;
    while (SUCCEEDED(pool->TryGetNextFrame(&frame)) && !(frame && usable(frame.Get())) && GetTickCount64() < until) {
        Closing skipped{frame};  // gives the pool's one buffer back
        Sleep(10);
    }
    if (!frame || !usable(frame.Get())) return "no frame came within the wait";
    Closing frame_closing{frame};
    ABI::Windows::Graphics::SizeInt32 content{};
    ComPtr<ABI::Windows::Graphics::DirectX::Direct3D11::IDirect3DSurface> surface;
    ComPtr<::Windows::Graphics::DirectX::Direct3D11::IDirect3DDxgiInterfaceAccess> access;
    ComPtr<ID3D11Texture2D> texture;
    if (FAILED(frame->get_ContentSize(&content)) || FAILED(frame->get_Surface(&surface)) ||
        FAILED(surface.As(&access)) || FAILED(access->GetInterface(IID_PPV_ARGS(&texture)))) {
        return "cannot read the frame's surface";
    }
    D3D11_TEXTURE2D_DESC desc{};
    texture->GetDesc(&desc);
    // The pool's buffer keeps the size at the start; a window that has shrunk since fills only part of it.
    RECT cut{0, 0, static_cast<LONG>(std::min(desc.Width, static_cast<UINT>(std::max(content.Width, 1)))),
             static_cast<LONG>(std::min(desc.Height, static_cast<UINT>(std::max(content.Height, 1))))};
    if (crop && !IntersectRect(&cut, &cut, crop)) return "the rect is outside the frame";
    UINT width = cut.right - cut.left, height = cut.bottom - cut.top;
    desc.Width = width;
    desc.Height = height;
    desc.MipLevels = 1;
    desc.ArraySize = 1;
    desc.Usage = D3D11_USAGE_STAGING;
    desc.BindFlags = 0;
    desc.CPUAccessFlags = D3D11_CPU_ACCESS_READ;
    desc.MiscFlags = 0;
    ComPtr<ID3D11Texture2D> staging;
    if (FAILED(device->CreateTexture2D(&desc, nullptr, &staging))) return "cannot create a staging texture";
    D3D11_BOX box{static_cast<UINT>(cut.left), static_cast<UINT>(cut.top), 0, static_cast<UINT>(cut.right),
                  static_cast<UINT>(cut.bottom), 1};
    context->CopySubresourceRegion(staging.Get(), 0, 0, 0, 0, texture.Get(), 0, &box);
    D3D11_MAPPED_SUBRESOURCE mapped{};
    if (FAILED(context->Map(staging.Get(), 0, D3D11_MAP_READ, 0, &mapped))) return "cannot map the staging texture";
    out.width = width;
    out.height = height;
    out.data.resize(static_cast<size_t>(width) * height * 4);
    for (UINT y = 0; y < height; ++y) {
        const BYTE* row = static_cast<const BYTE*>(mapped.pData) + static_cast<size_t>(y) * mapped.RowPitch;
        std::copy(row, row + width * 4, out.data.begin() + static_cast<ptrdiff_t>(y) * width * 4);
    }
    context->Unmap(staging.Get(), 0);
    return {};
}

// One frame of the window without the cursor, premultiplied BGRA; empty on success, else why not.
std::string grab_window(HWND hwnd, Pixels& out) {
    ComPtr<IGraphicsCaptureItemInterop> interop;
    ComPtr<wgc::IGraphicsCaptureItem> item;
    ABI::Windows::Graphics::SizeInt32 size{};
    if (FAILED(RoGetActivationFactory(HStringReference(RuntimeClass_Windows_Graphics_Capture_GraphicsCaptureItem).Get(),
                                      IID_PPV_ARGS(&interop))) ||
        FAILED(interop->CreateForWindow(hwnd, IID_PPV_ARGS(&item))) || FAILED(item->get_Size(&size)) ||
        size.Width <= 0 || size.Height <= 0) {
        return "Windows.Graphics.Capture cannot capture the window";
    }
    return grab_item(item.Get(), size, nullptr, nullptr, out);
}

// The long side scaled down to max_long_side when it is longer, the other side rounded to nearest (as on macOS).
void scaled_size(UINT& width, UINT& height, const json::Value* max_long_side) {
    UINT long_side = std::max(width, height);
    if (!max_long_side || max_long_side->i >= static_cast<int64_t>(long_side)) return;
    double scale = static_cast<double>(max_long_side->i) / long_side;
    width = std::max(1u, static_cast<UINT>(std::lround(width * scale)));
    height = std::max(1u, static_cast<UINT>(std::lround(height * scale)));
}

}  // namespace

Outcome capture_window(const json::Value& params) {
    HWND hwnd = reinterpret_cast<HWND>(static_cast<uintptr_t>(params.get("window_id")->i));
    if (!IsWindow(hwnd) || IsIconic(hwnd)) return failure("window_gone", "the window is gone or minimized");
    const json::Value* format = params.get("format");
    bool jpeg = format && format->s == "jpeg";
    Com com;
    ComPtr<IWICImagingFactory> factory = wic_factory();
    if (!factory) return failure("internal", "cannot create a WIC imaging factory");
    Pixels frame;
    std::string problem = grab_window(hwnd, frame);
    if (!problem.empty()) return failure(IsWindow(hwnd) ? "capture_failed" : "window_gone", problem);
    UINT width = frame.width, height = frame.height;
    scaled_size(width, height, params.get("max_long_side"));
    ComPtr<IWICBitmap> bitmap;
    Pixels sized;
    std::vector<BYTE> bytes;
    if (FAILED(factory->CreateBitmapFromMemory(frame.width, frame.height, GUID_WICPixelFormat32bppPBGRA,
                                               frame.width * 4, static_cast<UINT>(frame.data.size()),
                                               frame.data.data(), &bitmap)) ||
        !fit(factory.Get(), bitmap.Get(), width, height, sized) || !encode(factory.Get(), sized, jpeg, bytes)) {
        return failure("capture_failed", "the frame could not be scaled or encoded");
    }
    const json::Value* max_bytes = params.get("max_bytes");
    if (static_cast<int64_t>(bytes.size()) > (max_bytes ? max_bytes->i : kDefaultMaxBytes)) {
        return failure("too_large", "the encoded image has " + std::to_string(bytes.size()) + " bytes, over " +
                                        (max_bytes ? "max_bytes" : "the default max_bytes"));
    }
    json::Value image = json::object();
    image.set("format", json::str(jpeg ? "jpeg" : "png"));
    image.set("width", json::integer(width));
    image.set("height", json::integer(height));
    image.set("data", json::str(base64(bytes)));
    UINT dpi = GetDpiForWindow(hwnd);
    json::Value result = json::object();
    result.set("image", std::move(image));
    result.set("scale", json::number((dpi ? dpi : 96) / 96.0));
    return success(std::move(result));
}

std::string grab_window_frame(void* hwnd, unsigned& width, unsigned& height, std::vector<unsigned char>& bgra) {
    Pixels frame;
    std::string problem = grab_window(static_cast<HWND>(hwnd), frame);
    width = frame.width;
    height = frame.height;
    bgra = std::move(frame.data);
    return problem;
}

namespace {

// display_id's monitor, or the primary one when it is absent; nullptr when no monitor has that id.
HMONITOR monitor_of(const json::Value* display_id) {
    if (!display_id) return MonitorFromPoint(POINT{0, 0}, MONITOR_DEFAULTTOPRIMARY);
    std::pair<int64_t, HMONITOR> search{display_id->i, nullptr};
    EnumDisplayMonitors(nullptr, nullptr, [](HMONITOR monitor, HDC, LPRECT, LPARAM into) -> BOOL {
        auto* s = reinterpret_cast<std::pair<int64_t, HMONITOR>*>(into);
        if (static_cast<int64_t>(reinterpret_cast<uintptr_t>(monitor)) != s->first) return TRUE;
        s->second = monitor;
        return FALSE;
    }, reinterpret_cast<LPARAM>(&search));
    return search.second;
}

// The wallpaper file IDesktopWallpaper names for the monitor, else the one SPI_GETDESKWALLPAPER names; empty when
// the desktop is a plain colour.
std::wstring wallpaper_path(HMONITOR monitor) {
    MONITORINFO info{};
    info.cbSize = sizeof info;
    GetMonitorInfoW(monitor, &info);
    std::wstring path;
    ComPtr<IDesktopWallpaper> desktop;
    UINT count = 0;
    if (SUCCEEDED(CoCreateInstance(CLSID_DesktopWallpaper, nullptr, CLSCTX_ALL, IID_PPV_ARGS(&desktop))) &&
        SUCCEEDED(desktop->GetMonitorDevicePathCount(&count))) {
        for (UINT i = 0; i < count && path.empty(); ++i) {
            LPWSTR id = nullptr, file = nullptr;
            RECT bounds{};
            if (SUCCEEDED(desktop->GetMonitorDevicePathAt(i, &id)) && SUCCEEDED(desktop->GetMonitorRECT(id, &bounds)) &&
                EqualRect(&bounds, &info.rcMonitor) && SUCCEEDED(desktop->GetWallpaper(id, &file)) && file) {
                path = file;
            }
            CoTaskMemFree(file);
            CoTaskMemFree(id);
        }
    }
    if (path.empty()) {
        wchar_t file[MAX_PATH] = {};
        if (SystemParametersInfoW(SPI_GETDESKWALLPAPER, MAX_PATH, file, 0)) path = file;
    }
    return path;
}

// The visible top-level windows of pids.
std::vector<HWND> windows_of(const std::set<DWORD>& pids) {
    std::pair<const std::set<DWORD>*, std::vector<HWND>> search{&pids, {}};
    EnumWindows([](HWND hwnd, LPARAM into) -> BOOL {
        auto* s = reinterpret_cast<std::pair<const std::set<DWORD>*, std::vector<HWND>>*>(into);
        if (IsWindowVisible(hwnd) && s->first->count(win32::owner_pid(hwnd))) s->second.push_back(hwnd);
        return TRUE;
    }, reinterpret_cast<LPARAM>(&search));
    return search.second;
}

// The screen inside area, cut to the display its centre is on, with the windows of pids left out; empty on success,
// else why not (kNoExclusion when this Windows cannot leave windows out).
std::string grab_screen(const RECT& area, const std::set<DWORD>& pids, Pixels& out) {
    HMONITOR monitor = MonitorFromPoint(POINT{area.left + (area.right - area.left) / 2,
                                              area.top + (area.bottom - area.top) / 2},
                                        MONITOR_DEFAULTTONEAREST);
    MONITORINFO info{};
    info.cbSize = sizeof info;
    ComPtr<IGraphicsCaptureItemInterop> interop;
    ComPtr<wgc::IGraphicsCaptureItem> item;
    ABI::Windows::Graphics::SizeInt32 size{};
    if (!GetMonitorInfoW(monitor, &info) ||
        FAILED(RoGetActivationFactory(HStringReference(RuntimeClass_Windows_Graphics_Capture_GraphicsCaptureItem).Get(),
                                      IID_PPV_ARGS(&interop))) ||
        FAILED(interop->CreateForMonitor(monitor, IID_PPV_ARGS(&item))) || FAILED(item->get_Size(&size)) ||
        size.Width <= 0 || size.Height <= 0) {
        return "Windows.Graphics.Capture cannot capture the display";
    }
    RECT crop = area;
    OffsetRect(&crop, -info.rcMonitor.left, -info.rcMonitor.top);
    std::vector<HWND> excluded = windows_of(pids);
    return grab_item(item.Get(), size, &excluded, &crop, out);
}

// rect in physical pixels clipped to the virtual screen, else the whole of display_id's (or the primary) monitor;
// false when nothing is left.
bool screen_area(const json::Value& params, RECT& area) {
    if (const json::Value* rect = params.get("rect")) {
        double x = rect->get("x")->n, y = rect->get("y")->n;
        RECT asked{static_cast<LONG>(std::floor(x)), static_cast<LONG>(std::floor(y)),
                   static_cast<LONG>(std::ceil(x + rect->get("width")->n)),
                   static_cast<LONG>(std::ceil(y + rect->get("height")->n))};
        int left = GetSystemMetrics(SM_XVIRTUALSCREEN), top = GetSystemMetrics(SM_YVIRTUALSCREEN);
        RECT screen{left, top, left + GetSystemMetrics(SM_CXVIRTUALSCREEN), top + GetSystemMetrics(SM_CYVIRTUALSCREEN)};
        return IntersectRect(&area, &asked, &screen) != 0;
    }
    HMONITOR monitor = monitor_of(params.get("display_id"));
    MONITORINFO info{};
    info.cbSize = sizeof info;
    if (!monitor || !GetMonitorInfoW(monitor, &info)) return false;
    area = info.rcMonitor;
    return !IsRectEmpty(&area);
}

}  // namespace

Outcome capture_ambient(const json::Value& params) {
    UINT side = static_cast<UINT>(params.get("side")->i);
    Com com;
    ComPtr<IWICImagingFactory> factory = wic_factory();
    if (!factory) return failure("internal", "cannot create a WIC imaging factory");
    Pixels sampled;
    if (params.get("source")->s == "wallpaper") {
        HMONITOR monitor = monitor_of(params.get("display_id"));
        if (!monitor) return failure("capture_failed", "no display has that display_id");
        std::wstring path = wallpaper_path(monitor);
        if (path.empty()) {
            COLORREF colour = GetSysColor(COLOR_DESKTOP);
            sampled.width = sampled.height = side;
            sampled.data.resize(static_cast<size_t>(side) * side * 4);
            for (size_t p = 0; p < sampled.data.size(); p += 4) {
                sampled.data[p] = GetBValue(colour);
                sampled.data[p + 1] = GetGValue(colour);
                sampled.data[p + 2] = GetRValue(colour);
                sampled.data[p + 3] = 255;
            }
        } else {
            ComPtr<IWICBitmapDecoder> decoder;
            ComPtr<IWICBitmapFrameDecode> frame;
            if (FAILED(factory->CreateDecoderFromFilename(path.c_str(), nullptr, GENERIC_READ,
                                                          WICDecodeMetadataCacheOnDemand, &decoder)) ||
                FAILED(decoder->GetFrame(0, &frame)) || !fit(factory.Get(), frame.Get(), side, side, sampled)) {
                return failure("capture_failed", "the wallpaper file could not be decoded");
            }
        }
    } else {
        RECT area{};
        if (!screen_area(params, area)) return failure("capture_failed", "the rect is off every display");
        std::set<DWORD> pids;
        if (const json::Value* exclude = params.get("exclude_pids")) {
            for (const json::Value& pid : exclude->values) pids.insert(static_cast<DWORD>(pid.i));
        }
        Pixels screen;
        std::string problem = grab_screen(area, pids, screen);
        if (!problem.empty()) return failure(problem == kNoExclusion ? "unsupported" : "capture_failed", problem);
        ComPtr<IWICBitmap> bitmap;
        if (FAILED(factory->CreateBitmapFromMemory(screen.width, screen.height, GUID_WICPixelFormat32bppBGR,
                                                   screen.width * 4, static_cast<UINT>(screen.data.size()),
                                                   screen.data.data(), &bitmap)) ||
            !fit(factory.Get(), bitmap.Get(), side, side, sampled)) {
            return failure("capture_failed", "the screen could not be scaled");
        }
    }
    // BGRA to RGBA.
    for (size_t p = 0; p < sampled.data.size(); p += 4) std::swap(sampled.data[p], sampled.data[p + 2]);
    json::Value result = json::object();
    result.set("width", json::integer(side));
    result.set("height", json::integer(side));
    result.set("rgba", json::str(base64(sampled.data)));
    return success(std::move(result));
}
