// The OCR ops with Windows.Media.Ocr. A window_id is captured by ops_capture.cpp's frame grab, an
// image is decoded by WIC; either reaches OcrEngine as an opaque Bgra8 SoftwareBitmap.
#define NOMINMAX
#include <windows.h>
#include <MemoryBuffer.h>
#include <roapi.h>
#include <wincodec.h>
#include <windows.foundation.h>
#include <windows.globalization.h>
#include <windows.graphics.imaging.h>
#include <windows.media.ocr.h>
#include <wrl/client.h>
#include <wrl/wrappers/corewrappers.h>

#include <algorithm>
#include <cstdint>
#include <string>
#include <utility>
#include <vector>

#include "json.h"
#include "ops.h"
#include "win32.h"

namespace {

using Microsoft::WRL::ComPtr;
using Microsoft::WRL::Wrappers::HString;
using Microsoft::WRL::Wrappers::HStringReference;
namespace collections = ABI::Windows::Foundation::Collections;
namespace imaging = ABI::Windows::Graphics::Imaging;
namespace ocr = ABI::Windows::Media::Ocr;
using ABI::Windows::Globalization::ILanguage;

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

struct Language {
    std::string tag;
    ComPtr<ILanguage> language;
};

std::string text_of(const HString& text) {
    UINT32 length = 0;
    const wchar_t* raw = text.GetRawBuffer(&length);
    return win32::utf8(raw, length);
}

ComPtr<ocr::IOcrEngineStatics> engines() {
    ComPtr<ocr::IOcrEngineStatics> statics;
    RoGetActivationFactory(HStringReference(RuntimeClass_Windows_Media_Ocr_OcrEngine).Get(), IID_PPV_ARGS(&statics));
    return statics;
}

// OcrEngine::AvailableRecognizerLanguages with their BCP-47 tags.
std::vector<Language> available(ocr::IOcrEngineStatics* statics) {
    std::vector<Language> out;
    ComPtr<collections::IVectorView<ABI::Windows::Globalization::Language*>> list;
    UINT32 count = 0;
    if (!statics || FAILED(statics->get_AvailableRecognizerLanguages(&list)) || FAILED(list->get_Size(&count))) return out;
    for (UINT32 i = 0; i < count; ++i) {
        Language entry;
        HString tag;
        if (SUCCEEDED(list->GetAt(i, &entry.language)) && SUCCEEDED(entry.language->get_LanguageTag(tag.GetAddressOf()))) {
            entry.tag = text_of(tag);
            out.push_back(std::move(entry));
        }
    }
    return out;
}

std::string lower(std::string text) {
    for (char& c : text) c = static_cast<char>(c >= 'A' && c <= 'Z' ? c - 'A' + 'a' : c);
    return text;
}

bool starts_with(const std::string& text, const std::string& prefix) { return text.compare(0, prefix.size(), prefix) == 0; }

// The available language for a requested tag: the same tag, or one of the two extends the other (zh-Hans, zh-Hans-CN).
const Language* matching(const std::vector<Language>& languages, const std::string& asked) {
    std::string want = lower(asked);
    for (const Language& language : languages) {
        std::string have = lower(language.tag);
        if (have == want || starts_with(have, want + "-") || starts_with(want, have + "-")) return &language;
    }
    return nullptr;
}

// languages asked for, else the Chinese (Simplified first) and English ones available, else the first available.
std::vector<const Language*> chosen(const std::vector<Language>& languages, const json::Value* asked) {
    std::vector<const Language*> out;
    auto add = [&out](const Language* language) {
        if (language && std::find(out.begin(), out.end(), language) == out.end()) out.push_back(language);
    };
    if (asked && !asked->values.empty()) {
        for (const json::Value& tag : asked->values) add(matching(languages, tag.s));
        return out;
    }
    const Language* chinese = matching(languages, "zh-Hans");
    add(chinese ? chinese : matching(languages, "zh"));
    add(matching(languages, "en"));
    if (out.empty() && !languages.empty()) out.push_back(&languages.front());
    return out;
}

std::vector<BYTE> unbase64(const std::string& text) {
    std::vector<BYTE> out;
    out.reserve(text.size() / 4 * 3);
    uint32_t chunk = 0;
    int bits = 0;
    for (char c : text) {
        int digit = c >= 'A' && c <= 'Z' ? c - 'A' : c >= 'a' && c <= 'z' ? c - 'a' + 26
                  : c >= '0' && c <= '9' ? c - '0' + 52 : c == '+' ? 62 : c == '/' ? 63 : -1;
        if (digit < 0) continue;  // '=' padding; params_error has checked the alphabet
        chunk = chunk << 6 | static_cast<uint32_t>(digit);
        bits += 6;
        if (bits >= 8) {
            bits -= 8;
            out.push_back(static_cast<BYTE>(chunk >> bits & 0xFF));
        }
    }
    return out;
}

// source as an opaque Bgra8 SoftwareBitmap (transparency over white), scaled down so that no side is over max_side.
bool to_bitmap(IWICImagingFactory* factory, IWICBitmapSource* source, UINT max_side,
               ComPtr<imaging::ISoftwareBitmap>& out) {
    ComPtr<IWICFormatConverter> converter;
    UINT width = 0, height = 0;
    if (FAILED(factory->CreateFormatConverter(&converter)) ||
        FAILED(converter->Initialize(source, GUID_WICPixelFormat32bppPBGRA, WICBitmapDitherTypeNone, nullptr, 0,
                                     WICBitmapPaletteTypeCustom)) ||
        FAILED(converter->GetSize(&width, &height)) || width == 0 || height == 0) {
        return false;
    }
    ComPtr<IWICBitmapSource> sized = converter;
    if (std::max(width, height) > max_side) {
        double scale = static_cast<double>(max_side) / std::max(width, height);
        width = std::max(1u, std::min(max_side, static_cast<UINT>(width * scale + 0.5)));
        height = std::max(1u, std::min(max_side, static_cast<UINT>(height * scale + 0.5)));
        ComPtr<IWICBitmapScaler> scaler;
        if (FAILED(factory->CreateBitmapScaler(&scaler)) ||
            FAILED(scaler->Initialize(converter.Get(), width, height, WICBitmapInterpolationModeFant))) {
            return false;
        }
        sized = scaler;
    }
    std::vector<BYTE> pixels(static_cast<size_t>(width) * height * 4);
    if (FAILED(sized->CopyPixels(nullptr, width * 4, static_cast<UINT>(pixels.size()), pixels.data()))) return false;
    for (size_t p = 0; p < pixels.size(); p += 4) {
        BYTE alpha = pixels[p + 3];
        for (int c = 0; c < 3; ++c) pixels[p + c] = static_cast<BYTE>(std::min(255, pixels[p + c] + 255 - alpha));
        pixels[p + 3] = 255;
    }

    ComPtr<imaging::ISoftwareBitmapFactory> bitmaps;
    ComPtr<imaging::IBitmapBuffer> buffer;
    ComPtr<ABI::Windows::Foundation::IMemoryBuffer> memory;
    ComPtr<ABI::Windows::Foundation::IMemoryBufferReference> reference;
    ComPtr<::Windows::Foundation::IMemoryBufferByteAccess> access;
    imaging::BitmapPlaneDescription plane{};
    BYTE* data = nullptr;
    UINT32 capacity = 0;
    if (FAILED(RoGetActivationFactory(HStringReference(RuntimeClass_Windows_Graphics_Imaging_SoftwareBitmap).Get(),
                                      IID_PPV_ARGS(&bitmaps))) ||
        FAILED(bitmaps->Create(imaging::BitmapPixelFormat_Bgra8, static_cast<INT32>(width), static_cast<INT32>(height),
                               &out)) ||
        FAILED(out->LockBuffer(imaging::BitmapBufferAccessMode_Write, &buffer)) ||
        FAILED(buffer->GetPlaneDescription(0, &plane)) || FAILED(buffer.As(&memory)) ||
        FAILED(memory->CreateReference(&reference)) || FAILED(reference.As(&access)) ||
        FAILED(access->GetBuffer(&data, &capacity)) ||
        capacity < static_cast<UINT32>(plane.StartIndex) + static_cast<UINT32>(plane.Stride) * (height - 1) + width * 4) {
        return false;
    }
    for (UINT y = 0; y < height; ++y) {
        std::copy(pixels.begin() + static_cast<ptrdiff_t>(y) * width * 4,
                  pixels.begin() + static_cast<ptrdiff_t>(y + 1) * width * 4,
                  data + plane.StartIndex + static_cast<size_t>(y) * plane.Stride);
    }
    // The bitmap is readable only once its buffer and the reference to it are closed.
    ComPtr<ABI::Windows::Foundation::IClosable> closable;
    if (SUCCEEDED(reference.As(&closable))) closable->Close();
    if (SUCCEEDED(buffer.As(&closable))) closable->Close();
    return true;
}

bool cjk(wchar_t c) {
    return (c >= 0x2E80 && c <= 0x9FFF) || (c >= 0xF900 && c <= 0xFAFF) || (c >= 0xFE30 && c <= 0xFE4F) ||
           (c >= 0xFF00 && c <= 0xFFEF);
}

// text without the spaces Windows.Media.Ocr puts between two CJK characters.
std::wstring joined_cjk(const std::wstring& text) {
    std::wstring out;
    for (size_t i = 0; i < text.size(); ++i) {
        if (text[i] == L' ' && !out.empty() && cjk(out.back())) {
            size_t next = text.find_first_not_of(L' ', i);
            if (next != std::wstring::npos && cjk(text[next])) {
                i = next - 1;
                continue;
            }
        }
        out += text[i];
    }
    return out;
}

struct Line {
    std::string text;
    double x = 0, y = 0, width = 0, height = 0;  // normalized, top-left origin
    size_t engine = 0;
    bool fits = false;  // the line has CJK characters exactly when its engine's language is Chinese or Japanese
};

// How much of the smaller of a and b their intersection covers.
double overlap(const Line& a, const Line& b) {
    double w = std::min(a.x + a.width, b.x + b.width) - std::max(a.x, b.x);
    double h = std::min(a.y + a.height, b.y + b.height) - std::max(a.y, b.y);
    double smaller = std::min(a.width * a.height, b.width * b.height);
    return w > 0 && h > 0 && smaller > 0 ? w * h / smaller : 0;
}

// The lines one engine reads in bitmap, bounds normalized by its size; false when recognition failed.
bool recognize(ocr::IOcrEngine* engine, imaging::ISoftwareBitmap* bitmap, size_t index, bool cjk_language,
               std::vector<Line>& out) {
    INT32 width = 0, height = 0;
    ComPtr<ABI::Windows::Foundation::IAsyncOperation<ocr::OcrResult*>> operation;
    ComPtr<ABI::Windows::Foundation::IAsyncInfo> info;
    if (FAILED(bitmap->get_PixelWidth(&width)) || FAILED(bitmap->get_PixelHeight(&height)) ||
        FAILED(engine->RecognizeAsync(bitmap, &operation)) || FAILED(operation.As(&info))) {
        return false;
    }
    ABI::Windows::Foundation::AsyncStatus status = ABI::Windows::Foundation::AsyncStatus::Started;
    while (SUCCEEDED(info->get_Status(&status)) && status == ABI::Windows::Foundation::AsyncStatus::Started) Sleep(5);
    ComPtr<ocr::IOcrResult> result;
    ComPtr<collections::IVectorView<ocr::OcrLine*>> lines;
    UINT32 count = 0;
    if (status != ABI::Windows::Foundation::AsyncStatus::Completed || FAILED(operation->GetResults(&result)) ||
        !result || FAILED(result->get_Lines(&lines)) || FAILED(lines->get_Size(&count))) {
        return false;
    }
    for (UINT32 i = 0; i < count; ++i) {
        ComPtr<ocr::IOcrLine> line;
        ComPtr<collections::IVectorView<ocr::OcrWord*>> words;
        HString text;
        UINT32 word_count = 0;
        if (FAILED(lines->GetAt(i, &line)) || FAILED(line->get_Text(text.GetAddressOf())) ||
            FAILED(line->get_Words(&words)) || FAILED(words->get_Size(&word_count)) || word_count == 0) {
            continue;
        }
        float left = 1e30f, top = 1e30f, right = -1e30f, bottom = -1e30f;
        for (UINT32 j = 0; j < word_count; ++j) {
            ComPtr<ocr::IOcrWord> word;
            ABI::Windows::Foundation::Rect box{};
            if (FAILED(words->GetAt(j, &word)) || FAILED(word->get_BoundingRect(&box))) continue;
            left = std::min(left, box.X);
            top = std::min(top, box.Y);
            right = std::max(right, box.X + box.Width);
            bottom = std::max(bottom, box.Y + box.Height);
        }
        if (right < left || bottom < top) continue;
        UINT32 length = 0;
        const wchar_t* raw = text.GetRawBuffer(&length);
        std::wstring joined = joined_cjk(std::wstring(raw, length));
        Line read;
        read.text = win32::utf8(joined);
        read.fits = std::any_of(joined.begin(), joined.end(), cjk) == cjk_language;
        read.x = left / width;
        read.y = top / height;
        read.width = (right - left) / width;
        read.height = (bottom - top) / height;
        read.engine = index;
        out.push_back(std::move(read));
    }
    return true;
}

}  // namespace

Outcome ocr_languages(const json::Value&) {
    Com com;
    std::vector<Language> languages = available(engines().Get());
    if (languages.empty()) return failure("ocr_unavailable", "Windows.Media.Ocr has no recognizer language");
    json::Value tags = json::array();
    for (const Language& language : languages) tags.push(json::str(language.tag));
    json::Value result = json::object();
    result.set("languages", std::move(tags));
    return success(std::move(result));
}

Outcome ocr_recognize(const json::Value& params) {
    Com com;
    ComPtr<ocr::IOcrEngineStatics> statics = engines();
    std::vector<Language> languages = available(statics.Get());
    if (languages.empty()) return failure("ocr_unavailable", "Windows.Media.Ocr has no recognizer language");
    std::vector<const Language*> use = chosen(languages, params.get("languages"));
    if (use.empty()) return failure("ocr_unavailable", "no recognizer language matches the languages asked for");
    UINT32 max_side = 0;
    ComPtr<IWICImagingFactory> factory;
    CoCreateInstance(CLSID_WICImagingFactory, nullptr, CLSCTX_INPROC_SERVER, IID_PPV_ARGS(&factory));
    if (FAILED(statics->get_MaxImageDimension(&max_side)) || max_side == 0 || !factory) {
        return failure("internal", "cannot set up Windows.Media.Ocr or WIC");
    }

    ComPtr<imaging::ISoftwareBitmap> bitmap;
    if (const json::Value* id = params.get("window_id")) {
        HWND hwnd = reinterpret_cast<HWND>(static_cast<uintptr_t>(id->i));
        if (!IsWindow(hwnd) || IsIconic(hwnd)) return failure("window_gone", "the window is gone or minimized");
        DWORD affinity = WDA_NONE;
        if (GetWindowDisplayAffinity(hwnd, &affinity) && affinity != WDA_NONE) {
            return failure("capture_failed", "the window's display affinity keeps it out of captures");
        }
        unsigned width = 0, height = 0;
        std::vector<unsigned char> frame;
        std::string problem = grab_window_frame(hwnd, width, height, frame);
        if (!problem.empty()) return failure(IsWindow(hwnd) ? "capture_failed" : "window_gone", problem);
        ComPtr<IWICBitmap> wic;
        if (FAILED(factory->CreateBitmapFromMemory(width, height, GUID_WICPixelFormat32bppPBGRA, width * 4,
                                                   static_cast<UINT>(frame.size()), frame.data(), &wic)) ||
            !to_bitmap(factory.Get(), wic.Get(), max_side, bitmap)) {
            return failure("capture_failed", "the frame could not be made into a bitmap");
        }
    } else {
        std::vector<BYTE> bytes = unbase64(params.get("image")->get("data")->s);
        ComPtr<IWICStream> stream;
        ComPtr<IWICBitmapDecoder> decoder;
        ComPtr<IWICBitmapFrameDecode> frame;
        if (bytes.empty() || FAILED(factory->CreateStream(&stream)) ||
            FAILED(stream->InitializeFromMemory(bytes.data(), static_cast<DWORD>(bytes.size()))) ||
            FAILED(factory->CreateDecoderFromStream(stream.Get(), nullptr, WICDecodeMetadataCacheOnDemand, &decoder)) ||
            FAILED(decoder->GetFrame(0, &frame)) || !to_bitmap(factory.Get(), frame.Get(), max_side, bitmap)) {
            return failure("bad_request", "the image does not decode");
        }
    }

    std::vector<Line> read;
    json::Value tags = json::array();
    for (size_t index = 0; index < use.size(); ++index) {
        ComPtr<ocr::IOcrEngine> engine;
        if (FAILED(statics->TryCreateFromLanguage(use[index]->language.Get(), &engine)) || !engine) {
            return failure("ocr_unavailable", "no recognizer for " + use[index]->tag);
        }
        std::string tag = lower(use[index]->tag);
        bool cjk_language = starts_with(tag + "-", "zh-") || starts_with(tag + "-", "ja-");
        if (!recognize(engine.Get(), bitmap.Get(), index, cjk_language, read)) {
            return failure("internal", "OCR recognition failed");
        }
        tags.push(json::str(use[index]->tag));
    }
    // Two languages reading a line in the same place read the same text: keep the reading whose script fits the
    // language, else the earlier language's.
    std::stable_sort(read.begin(), read.end(), [](const Line& a, const Line& b) {
        return a.fits != b.fits ? a.fits : a.engine < b.engine;
    });
    std::vector<Line> lines;
    for (Line& line : read) {
        bool seen = std::any_of(lines.begin(), lines.end(), [&line](const Line& kept) {
            return kept.engine != line.engine && overlap(kept, line) > 0.5;
        });
        if (!seen) lines.push_back(std::move(line));
    }
    std::stable_sort(lines.begin(), lines.end(), [](const Line& a, const Line& b) {
        return a.y != b.y ? a.y < b.y : a.x < b.x;
    });

    std::string text;
    json::Value out = json::array();
    for (const Line& line : lines) {
        if (&line != &lines.front()) text += '\n';
        text += line.text;
        json::Value bounds = json::object();
        bounds.set("x", json::number(line.x));
        bounds.set("y", json::number(line.y));
        bounds.set("width", json::number(line.width));
        bounds.set("height", json::number(line.height));
        json::Value entry = json::object();
        entry.set("text", json::str(line.text));
        entry.set("bounds", std::move(bounds));
        out.push(std::move(entry));
    }
    json::Value result = json::object();
    result.set("text", json::str(std::move(text)));
    result.set("lines", std::move(out));
    result.set("languages", std::move(tags));
    return success(std::move(result));
}
