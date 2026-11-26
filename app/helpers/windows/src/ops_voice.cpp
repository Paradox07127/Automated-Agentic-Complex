// The voice ops (speech.locales, mic.start, mic.stop, ptt.register, ptt.unregister) and their events.
// The hot key reads the keyboard Raw Input of ops_attention.cpp's watch window; the microphone is a WASAPI
// shared-mode capture that Windows converts to 16 kHz mono float; recognition is sherpa-onnx's offline SenseVoice
// recognizer from the DLLs beside ac-helper.exe (third_party.ps1), with a model the first mic.start downloads.
#define NOMINMAX
#include <windows.h>
#include <mmreg.h>
#include <audioclient.h>
#include <bcrypt.h>
#include <knownfolders.h>
#include <mmdeviceapi.h>
#include <objbase.h>
#include <shlobj.h>
#include <winhttp.h>
#include <wrl/client.h>

#include <algorithm>
#include <atomic>
#include <chrono>
#include <cmath>
#include <condition_variable>
#include <cstdint>
#include <cstdio>
#include <cstring>
#include <future>
#include <memory>
#include <mutex>
#include <string>
#include <thread>
#include <type_traits>
#include <utility>
#include <vector>

#include "json.h"
#include "ops.h"
#include "sherpa-onnx/c-api/c-api.h"
#include "win32.h"

namespace {

using Microsoft::WRL::ComPtr;
using namespace win32;

constexpr int kSampleRate = 16000;
constexpr uint64_t kMaxSessionSamples = 60ull * kSampleRate;  // neither the contract nor the shell caps a session
constexpr uint64_t kStartBudgetMs = 110000;                    // under mic.start's timeout_ms of 120 s
constexpr DWORD kLevelMs = 50;                                 // at most 20 mic.level a second
constexpr DWORD kPartialMs = 600;
constexpr DWORD kDownloadMs = 250;

// SenseVoice-Small int8, sherpa-onnx's export of FunAudioLLM/SenseVoice (sense-voice-zh-en-ja-ko-yue-2024-07-17),
// at a fixed revision. Its licence is FunASR's model licence, as NOTICE says.
struct ModelFile {
    const wchar_t* name;
    const wchar_t* url;
    uint64_t size;
    const char* sha256;
};
const ModelFile kModel[] = {
    {L"model.int8.onnx",
     L"https://huggingface.co/csukuangfj/sherpa-onnx-sense-voice-zh-en-ja-ko-yue-2024-07-17/resolve/"
     L"2365baeacb507f821a0c8120fcee3d484dba7a07/model.int8.onnx",
     239233841, "c71f0ce00bec95b07744e116345e33d8cbbe08cef896382cf907bf4b51a2cd51"},
    {L"tokens.txt",
     L"https://huggingface.co/csukuangfj/sherpa-onnx-sense-voice-zh-en-ja-ko-yue-2024-07-17/resolve/"
     L"2365baeacb507f821a0c8120fcee3d484dba7a07/tokens.txt",
     315894, "f449eb28dc567533d7fa59be34e2abca8784f771850c78a47fb731a31429a1dc"},
};

// speech.locales: the languages SenseVoice covers, and the language subtag each stands for.
const std::pair<const char*, const char*> kLocales[] = {
    {"zh", "zh-CN"}, {"en", "en-US"}, {"ja", "ja-JP"}, {"ko", "ko-KR"}, {"yue", "yue-HK"}};

std::wstring wide(const std::string& text) {
    if (text.empty()) return {};
    int chars = MultiByteToWideChar(CP_UTF8, 0, text.data(), static_cast<int>(text.size()), nullptr, 0);
    std::wstring out(static_cast<size_t>(chars > 0 ? chars : 0), L'\0');
    if (chars > 0) MultiByteToWideChar(CP_UTF8, 0, text.data(), static_cast<int>(text.size()), out.data(), chars);
    return out;
}

std::string ascii_lower(std::string text) {
    for (char& c : text) {
        if (c >= 'A' && c <= 'Z') c = static_cast<char>(c - 'A' + 'a');
    }
    return text;
}

std::string hresult_text(HRESULT hr) {
    char text[16];
    std::snprintf(text, sizeof text, "0x%08lX", static_cast<unsigned long>(hr));
    return text;
}

// MARK: sherpa-onnx

// The C API functions this file calls, from the DLL beside ac-helper.exe; nullptr when it is missing or does not load.
struct Sherpa {
    decltype(&SherpaOnnxCreateOfflineRecognizer) create_recognizer = nullptr;
    decltype(&SherpaOnnxCreateOfflineStream) create_stream = nullptr;
    decltype(&SherpaOnnxDestroyOfflineStream) destroy_stream = nullptr;
    decltype(&SherpaOnnxAcceptWaveformOffline) accept = nullptr;
    decltype(&SherpaOnnxDecodeOfflineStream) decode = nullptr;
    decltype(&SherpaOnnxGetOfflineStreamResult) result = nullptr;
    decltype(&SherpaOnnxDestroyOfflineRecognizerResult) destroy_result = nullptr;
    decltype(&SherpaOnnxReadWave) read_wave = nullptr;
    decltype(&SherpaOnnxFreeWave) free_wave = nullptr;
};

std::wstring helper_dir() {
    std::wstring path(512, L'\0');
    for (;;) {
        DWORD length = GetModuleFileNameW(nullptr, path.data(), static_cast<DWORD>(path.size()));
        if (length == 0) return {};
        if (length < path.size()) {
            path.resize(length);
            break;
        }
        path.resize(path.size() * 2);
    }
    return path.substr(0, path.find_last_of(L'\\'));
}

const Sherpa* sherpa() {
    static std::once_flag once;
    static Sherpa api;
    static bool loaded = false;
    std::call_once(once, [] {
        std::wstring dir = helper_dir();
        DWORD search = LOAD_LIBRARY_SEARCH_DLL_LOAD_DIR | LOAD_LIBRARY_SEARCH_DEFAULT_DIRS;
        // Ours first, by its path: sherpa-onnx imports onnxruntime.dll by name, and System32 may hold an older one.
        HMODULE runtime = LoadLibraryExW((dir + L"\\onnxruntime.dll").c_str(), nullptr, search);
        HMODULE module = runtime ? LoadLibraryExW((dir + L"\\sherpa-onnx-c-api.dll").c_str(), nullptr, search) : nullptr;
        if (!module) return;
        auto find = [module](auto& function, const char* name) {
            function = reinterpret_cast<std::remove_reference_t<decltype(function)>>(GetProcAddress(module, name));
            return function != nullptr;
        };
        loaded = find(api.create_recognizer, "SherpaOnnxCreateOfflineRecognizer") &&
                 find(api.create_stream, "SherpaOnnxCreateOfflineStream") &&
                 find(api.destroy_stream, "SherpaOnnxDestroyOfflineStream") &&
                 find(api.accept, "SherpaOnnxAcceptWaveformOffline") &&
                 find(api.decode, "SherpaOnnxDecodeOfflineStream") &&
                 find(api.result, "SherpaOnnxGetOfflineStreamResult") &&
                 find(api.destroy_result, "SherpaOnnxDestroyOfflineRecognizerResult") &&
                 find(api.read_wave, "SherpaOnnxReadWave") && find(api.free_wave, "SherpaOnnxFreeWave");
    });
    return loaded ? &api : nullptr;
}

// MARK: the model

// AC_HELPER_MODELS_DIR (the replay's empty directory) or %LOCALAPPDATA%\AgenticComplex\models, then the model's own
// directory named by its sha256's start.
std::wstring model_dir() {
    std::wstring base(32768, L'\0');
    DWORD length = GetEnvironmentVariableW(L"AC_HELPER_MODELS_DIR", base.data(), static_cast<DWORD>(base.size()));
    if (length > 0 && length < base.size()) {
        base.resize(length);
    } else {
        PWSTR local = nullptr;
        base = SUCCEEDED(SHGetKnownFolderPath(FOLDERID_LocalAppData, 0, nullptr, &local)) ? local : L"";
        CoTaskMemFree(local);
        if (base.empty()) return {};
        base += L"\\AgenticComplex\\models";
    }
    return base + L"\\sensevoice-" + wide(std::string(kModel[0].sha256, 8));
}

bool file_size_is(const std::wstring& path, uint64_t size) {
    WIN32_FILE_ATTRIBUTE_DATA data{};
    if (!GetFileAttributesExW(path.c_str(), GetFileExInfoStandard, &data)) return false;
    return (static_cast<uint64_t>(data.nFileSizeHigh) << 32 | data.nFileSizeLow) == size;
}

bool model_present(const std::wstring& dir) {
    for (const ModelFile& file : kModel) {
        if (!file_size_is(dir + L"\\" + file.name, file.size)) return false;
    }
    return true;
}

class Sha256 {
public:
    Sha256() {
        if (BCRYPT_SUCCESS(BCryptOpenAlgorithmProvider(&algorithm_, BCRYPT_SHA256_ALGORITHM, nullptr, 0)) &&
            !BCRYPT_SUCCESS(BCryptCreateHash(algorithm_, &hash_, nullptr, 0, nullptr, 0, 0))) {
            hash_ = nullptr;
        }
    }
    ~Sha256() {
        if (hash_) BCryptDestroyHash(hash_);
        if (algorithm_) BCryptCloseAlgorithmProvider(algorithm_, 0);
    }
    Sha256(const Sha256&) = delete;
    Sha256& operator=(const Sha256&) = delete;
    void add(const void* data, size_t size) {
        if (hash_) BCryptHashData(hash_, static_cast<PUCHAR>(const_cast<void*>(data)), static_cast<ULONG>(size), 0);
    }
    // Lower-case hex, or empty when hashing failed.
    std::string hex() {
        UCHAR digest[32];
        if (!hash_ || !BCRYPT_SUCCESS(BCryptFinishHash(hash_, digest, sizeof digest, 0))) return {};
        static const char* digits = "0123456789abcdef";
        std::string out;
        for (UCHAR byte : digest) {
            out += digits[byte >> 4];
            out += digits[byte & 15];
        }
        return out;
    }

private:
    BCRYPT_ALG_HANDLE algorithm_ = nullptr;
    BCRYPT_HASH_HANDLE hash_ = nullptr;
};

std::string file_sha256(const std::wstring& path) {
    HANDLE file = CreateFileW(path.c_str(), GENERIC_READ, FILE_SHARE_READ, nullptr, OPEN_EXISTING,
                              FILE_FLAG_SEQUENTIAL_SCAN, nullptr);
    if (file == INVALID_HANDLE_VALUE) return {};
    Sha256 hash;
    std::vector<char> buffer(1 << 20);
    bool ok = true;
    for (;;) {
        DWORD got = 0;
        ok = ReadFile(file, buffer.data(), static_cast<DWORD>(buffer.size()), &got, nullptr) != 0;
        if (!ok || got == 0) break;
        hash.add(buffer.data(), got);
    }
    CloseHandle(file);
    return ok ? hash.hex() : std::string();
}

// The download the first mic.start that needs the model starts; it goes on when that mic.start has to answer, and a
// later mic.start waits for the same one.
struct Download {
    std::mutex lock;
    std::condition_variable ended;
    bool running = false;
    uint64_t completed = 0, total = 0;  // bytes of the files being fetched
    std::string error;                  // why the last one failed, else empty
} g_download;

class WinHttp {
public:
    explicit WinHttp(HINTERNET handle) : handle_(handle) {}
    ~WinHttp() {
        if (handle_) WinHttpCloseHandle(handle_);
    }
    WinHttp(const WinHttp&) = delete;
    WinHttp& operator=(const WinHttp&) = delete;
    HINTERNET get() const { return handle_; }

private:
    HINTERNET handle_;
};

// Fetches file into dir under a temporary name and renames it once its size and sha256 match; empty on success, else
// why not, with nothing left under either name.
std::string fetch(const ModelFile& file, const std::wstring& dir) {
    std::wstring final_path = dir + L"\\" + file.name, part = final_path + L".part";
    URL_COMPONENTS url{};
    url.dwStructSize = sizeof url;
    url.dwHostNameLength = url.dwUrlPathLength = url.dwExtraInfoLength = static_cast<DWORD>(-1);
    if (!WinHttpCrackUrl(file.url, 0, 0, &url)) return "the model URL does not parse";
    std::wstring host(url.lpszHostName, url.dwHostNameLength);
    std::wstring path = std::wstring(url.lpszUrlPath, url.dwUrlPathLength) +
                        std::wstring(url.lpszExtraInfo ? url.lpszExtraInfo : L"", url.dwExtraInfoLength);
    WinHttp session(WinHttpOpen(L"ac-helper", WINHTTP_ACCESS_TYPE_AUTOMATIC_PROXY, WINHTTP_NO_PROXY_NAME,
                                WINHTTP_NO_PROXY_BYPASS, 0));
    if (!session.get()) return "WinHttpOpen failed (" + std::to_string(GetLastError()) + ")";
    WinHttpSetTimeouts(session.get(), 15000, 15000, 30000, 30000);
    WinHttp connection(WinHttpConnect(session.get(), host.c_str(), url.nPort, 0));
    WinHttp request(connection.get() ? WinHttpOpenRequest(connection.get(), L"GET", path.c_str(), nullptr,
                                                          WINHTTP_NO_REFERER, WINHTTP_DEFAULT_ACCEPT_TYPES,
                                                          WINHTTP_FLAG_SECURE)
                                     : nullptr);
    DWORD status = 0, size = sizeof status;
    if (!request.get() ||
        !WinHttpSendRequest(request.get(), WINHTTP_NO_ADDITIONAL_HEADERS, 0, WINHTTP_NO_REQUEST_DATA, 0, 0, 0) ||
        !WinHttpReceiveResponse(request.get(), nullptr) ||
        !WinHttpQueryHeaders(request.get(), WINHTTP_QUERY_STATUS_CODE | WINHTTP_QUERY_FLAG_NUMBER,
                             WINHTTP_HEADER_NAME_BY_INDEX, &status, &size, WINHTTP_NO_HEADER_INDEX)) {
        return "the model server did not answer (WinHTTP " + std::to_string(GetLastError()) + ")";
    }
    if (status != 200) return "the model server answered HTTP " + std::to_string(status);
    HANDLE out = CreateFileW(part.c_str(), GENERIC_WRITE, 0, nullptr, CREATE_ALWAYS, FILE_ATTRIBUTE_NORMAL, nullptr);
    if (out == INVALID_HANDLE_VALUE) return "cannot write in the models directory (" + std::to_string(GetLastError()) + ")";
    Sha256 hash;
    std::vector<char> buffer(1 << 16);
    uint64_t received = 0;
    std::string problem;
    for (;;) {
        DWORD got = 0, wrote = 0;
        if (!WinHttpReadData(request.get(), buffer.data(), static_cast<DWORD>(buffer.size()), &got)) {
            problem = "the model download broke off (WinHTTP " + std::to_string(GetLastError()) + ")";
            break;
        }
        if (got == 0) break;
        received += got;
        if (received > file.size) {
            problem = "the model file is longer than it should be";
            break;
        }
        if (!WriteFile(out, buffer.data(), got, &wrote, nullptr) || wrote != got) {
            problem = "cannot write the model file (" + std::to_string(GetLastError()) + ")";
            break;
        }
        hash.add(buffer.data(), got);
        std::lock_guard<std::mutex> hold(g_download.lock);
        g_download.completed += got;
    }
    CloseHandle(out);
    if (problem.empty() && received != file.size) problem = "the model download ended early";
    if (problem.empty() && hash.hex() != file.sha256) problem = "the downloaded model file does not have its sha256";
    if (problem.empty() && !MoveFileExW(part.c_str(), final_path.c_str(), MOVEFILE_REPLACE_EXISTING)) {
        problem = "cannot rename the model file (" + std::to_string(GetLastError()) + ")";
    }
    if (!problem.empty()) DeleteFileW(part.c_str());
    return problem;
}

void download_thread(std::wstring dir) {
    std::string problem;
    int made = SHCreateDirectoryExW(nullptr, dir.c_str(), nullptr);
    if (made != ERROR_SUCCESS && made != ERROR_ALREADY_EXISTS && made != ERROR_FILE_EXISTS) {
        problem = "cannot create the models directory (" + std::to_string(made) + ")";
    }
    for (const ModelFile& file : kModel) {
        if (!problem.empty()) break;
        if (!file_size_is(dir + L"\\" + file.name, file.size)) problem = fetch(file, dir);
    }
    std::lock_guard<std::mutex> hold(g_download.lock);
    g_download.running = false;
    g_download.error = problem;
    g_download.ended.notify_all();
}

// Empty once the model is in dir, else why not; retryable when a later try may succeed. While the download runs it
// sends speech.download every 250 ms for session, unless session is null.
std::string ensure_model(const std::wstring& dir, uint64_t deadline, const std::string* session, bool& retryable) {
    if (dir.empty()) return "there is no local application data directory for the model";
    if (model_present(dir)) return {};
    {
        std::lock_guard<std::mutex> hold(g_download.lock);
        if (!g_download.running) {
            g_download.running = true;
            g_download.error.clear();
            g_download.completed = g_download.total = 0;
            for (const ModelFile& file : kModel) {
                if (!file_size_is(dir + L"\\" + file.name, file.size)) g_download.total += file.size;
            }
            try {
                std::thread(download_thread, dir).detach();
            } catch (const std::exception&) {
                g_download.running = false;
                return "cannot start a thread for the model download";
            }
        }
    }
    // Only this mic.start sends, until it is answered or cancelled.
    std::shared_ptr<Request> request = session ? this_request() : nullptr;
    for (;;) {
        std::unique_lock<std::mutex> hold(g_download.lock);
        g_download.ended.wait_for(hold, std::chrono::milliseconds(kDownloadMs), [] { return !g_download.running; });
        if (!g_download.running) {
            retryable = true;
            if (!g_download.error.empty()) return g_download.error;
            break;
        }
        uint64_t completed = g_download.completed, total = g_download.total;
        hold.unlock();
        if (session) {
            json::Value data = json::object();
            data.set("session", json::str(*session));
            data.set("fraction", json::number(total ? static_cast<double>(completed) / static_cast<double>(total) : 0));
            data.set("completed", json::integer(static_cast<int64_t>(completed)));
            data.set("total", json::integer(static_cast<int64_t>(total)));
            send_event("speech.download", std::move(data), request->open);
        }
        if (GetTickCount64() >= deadline) {
            retryable = true;
            return "the model download is still running";
        }
    }
    return model_present(dir) ? std::string() : "the model download ended without the model";
}

// Held while the recognizer loads and while it decodes.
std::mutex g_recognizer_lock;
const SherpaOnnxOfflineRecognizer* g_recognizer = nullptr;  // loaded once, kept while the helper runs
std::vector<std::wstring> g_checked;                       // model files whose sha256 this process has matched

// Empty once the recognizer is loaded, else why not. A model file whose sha256 does not match is removed.
std::string load_recognizer(const Sherpa& api, const std::wstring& dir) {
    std::lock_guard<std::mutex> hold(g_recognizer_lock);
    if (g_recognizer) return {};
    for (const ModelFile& file : kModel) {
        std::wstring path = dir + L"\\" + file.name;
        if (std::find(g_checked.begin(), g_checked.end(), path) != g_checked.end()) continue;
        if (file_sha256(path) != file.sha256) {
            DeleteFileW(path.c_str());
            return "a model file does not have its sha256; removed";
        }
        g_checked.push_back(path);
    }
    std::string model = utf8(dir + L"\\model.int8.onnx"), tokens = utf8(dir + L"\\tokens.txt");
    SherpaOnnxOfflineRecognizerConfig config{};
    config.feat_config.sample_rate = kSampleRate;
    config.feat_config.feature_dim = 80;
    config.model_config.sense_voice.model = model.c_str();
    config.model_config.sense_voice.language = "auto";
    config.model_config.sense_voice.use_itn = 1;
    config.model_config.tokens = tokens.c_str();
    config.model_config.num_threads = static_cast<int32_t>(std::clamp(std::thread::hardware_concurrency() / 2, 1u, 4u));
    config.model_config.provider = "cpu";
    config.decoding_method = "greedy_search";
    g_recognizer = api.create_recognizer(&config);
    return g_recognizer ? std::string() : "sherpa-onnx could not load the SenseVoice model";
}

// The text of 16 kHz mono samples, decoded at once; empty without a recognizer.
std::string transcribe(const Sherpa& api, const float* samples, size_t count) {
    std::lock_guard<std::mutex> hold(g_recognizer_lock);
    if (!g_recognizer || count == 0) return {};
    const SherpaOnnxOfflineStream* stream = api.create_stream(g_recognizer);
    if (!stream) return {};
    api.accept(stream, kSampleRate, samples, static_cast<int32_t>(count));
    api.decode(g_recognizer, stream);
    const SherpaOnnxOfflineRecognizerResult* result = api.result(stream);
    std::string text = result && result->text ? result->text : "";
    if (result) api.destroy_result(result);
    api.destroy_stream(stream);
    return text;
}

// MARK: the microphone

struct Opened {
    std::string code, message;  // empty code: the capture is initialized
};

// One session from mic.start until mic.stop takes it.
struct Session {
    std::string id;
    bool transcribe = true, levels = false;
    std::atomic<bool> live{false};  // mic.start has answered; its events go out until mic.stop
    std::atomic<bool> stop{false};
    HANDLE go = CreateEventW(nullptr, TRUE, FALSE, nullptr);    // set when it may record, or with stop to end
    HANDLE done = CreateEventW(nullptr, TRUE, FALSE, nullptr);  // set with stop
    std::thread capture, level_sender, partial_sender;
    std::mutex lock;  // the fields below
    std::vector<float> audio;
    double squares = 0;  // since the last mic.level
    size_t squared = 0;
    uint64_t started_ms = 0;
    bool answered = false;  // guarded by g_mic_lock

    ~Session() {
        CloseHandle(go);
        CloseHandle(done);
    }
};

std::mutex g_mic_lock;
std::shared_ptr<Session> g_current;    // the one session
std::shared_ptr<Session> g_answering;  // the session whose mic.start success is being written

// Adds count samples, or silence for null samples, up to the session's cap; whether the cap is reached.
bool record(Session& s, const float* samples, size_t count) {
    std::lock_guard<std::mutex> hold(s.lock);
    size_t take = std::min<size_t>(count, static_cast<size_t>(kMaxSessionSamples) - s.audio.size());
    for (size_t k = 0; k < take; ++k) {
        float v = samples ? samples[k] : 0.0f;
        s.audio.push_back(v);
        s.squares += static_cast<double>(v) * v;
    }
    s.squared += take;
    return s.audio.size() >= kMaxSessionSamples;
}

// The replay's switch for a machine without a microphone: AC_HELPER_MIC_WAV names a 16 kHz WAV that plays in place
// of the microphone, in real time and then as silence.
void play_wav(std::shared_ptr<Session> s, std::promise<Opened> opened, const std::wstring& path) {
    const Sherpa* api = sherpa();
    const SherpaOnnxWave* wave = api ? api->read_wave(utf8(path).c_str()) : nullptr;
    if (!wave || wave->sample_rate != kSampleRate) {
        if (wave) api->free_wave(wave);
        opened.set_value({"no_audio_device", "AC_HELPER_MIC_WAV is not a 16 kHz WAV"});
        return;
    }
    opened.set_value({});
    WaitForSingleObject(s->go, INFINITE);
    {
        std::lock_guard<std::mutex> hold(s->lock);
        s->started_ms = GetTickCount64();
    }
    const size_t chunk = kSampleRate / 20, total = static_cast<size_t>(wave->num_samples);
    size_t at = 0;
    bool full = false;
    while (!full && WaitForSingleObject(s->done, 50) == WAIT_TIMEOUT) {
        size_t take = std::min(chunk, total - at);
        full = record(*s, wave->samples + at, take) || record(*s, nullptr, chunk - take);
        at += take;
    }
    api->free_wave(wave);
}

// Initializes the default capture endpoint for 16 kHz mono float, tells mic.start how that went, waits for go and
// records until stop or the session's cap. All WASAPI calls stay on this thread.
void capture_thread(std::shared_ptr<Session> s, std::promise<Opened> opened) {
    std::wstring wav(32768, L'\0');
    wav.resize(GetEnvironmentVariableW(L"AC_HELPER_MIC_WAV", wav.data(), static_cast<DWORD>(wav.size())));
    if (!wav.empty()) return play_wav(std::move(s), std::move(opened), wav);
    HRESULT com = CoInitializeEx(nullptr, COINIT_MULTITHREADED);
    {
        ComPtr<IMMDeviceEnumerator> devices;
        ComPtr<IMMDevice> device;
        ComPtr<IAudioClient> client;
        ComPtr<IAudioCaptureClient> reader;
        HANDLE ready = CreateEventW(nullptr, FALSE, FALSE, nullptr);
        WAVEFORMATEX format{};
        format.wFormatTag = WAVE_FORMAT_IEEE_FLOAT;
        format.nChannels = 1;
        format.nSamplesPerSec = kSampleRate;
        format.wBitsPerSample = 32;
        format.nBlockAlign = 4;
        format.nAvgBytesPerSec = kSampleRate * 4;
        Opened result;
        HRESULT hr = CoCreateInstance(__uuidof(MMDeviceEnumerator), nullptr, CLSCTX_ALL, IID_PPV_ARGS(&devices));
        if (SUCCEEDED(hr)) {
            hr = devices->GetDefaultAudioEndpoint(eCapture, eConsole, &device);
            if (FAILED(hr)) result = {"no_audio_device", "there is no default audio input device"};
        }
        if (SUCCEEDED(hr)) {
            hr = device->Activate(__uuidof(IAudioClient), CLSCTX_ALL, nullptr,
                                  reinterpret_cast<void**>(client.GetAddressOf()));
        }
        const REFERENCE_TIME buffer = 2000000;  // 200 ms in 100 ns
        if (SUCCEEDED(hr)) {
            hr = client->Initialize(AUDCLNT_SHAREMODE_SHARED,
                                    AUDCLNT_STREAMFLAGS_EVENTCALLBACK | AUDCLNT_STREAMFLAGS_AUTOCONVERTPCM |
                                        AUDCLNT_STREAMFLAGS_SRC_DEFAULT_QUALITY,
                                    buffer, 0, &format, nullptr);
        }
        if (SUCCEEDED(hr) && ready) hr = client->SetEventHandle(ready);
        if (SUCCEEDED(hr)) hr = client->GetService(IID_PPV_ARGS(&reader));
        if (FAILED(hr) && result.code.empty()) {
            // The microphone privacy switches make WASAPI refuse with access denied; no dialog is shown.
            if (hr == E_ACCESSDENIED) result = {"permission_denied", "Windows' microphone privacy setting denies access"};
            else if (hr == AUDCLNT_E_DEVICE_INVALIDATED || hr == HRESULT_FROM_WIN32(ERROR_NOT_FOUND))
                result = {"no_audio_device", "the audio input device is gone"};
            else result = {"internal", "WASAPI capture failed with " + hresult_text(hr)};
        }
        if (SUCCEEDED(hr) && !ready) result = {"internal", "cannot create the capture event"};
        bool usable = result.code.empty();
        opened.set_value(std::move(result));
        if (usable) WaitForSingleObject(s->go, INFINITE);
        if (usable && !s->stop) hr = client->Start();
        if (usable && !s->stop && SUCCEEDED(hr)) {
            {
                std::lock_guard<std::mutex> hold(s->lock);
                s->started_ms = GetTickCount64();
            }
            bool full = false;
            while (!s->stop && !full) {
                WaitForSingleObject(ready, 100);
                UINT32 packet = 0;
                while (!full && SUCCEEDED(reader->GetNextPacketSize(&packet)) && packet > 0) {
                    BYTE* data = nullptr;
                    UINT32 frames = 0;
                    DWORD flags = 0;
                    if (FAILED(reader->GetBuffer(&data, &frames, &flags, nullptr, nullptr))) break;
                    bool silent = (flags & AUDCLNT_BUFFERFLAGS_SILENT) != 0;
                    full = record(*s, silent ? nullptr : reinterpret_cast<const float*>(data), frames);
                    reader->ReleaseBuffer(frames);
                }
            }
            client->Stop();
        } else if (usable && !s->stop) {
            std::fprintf(stderr, "ac-helper: the microphone did not start (%s)\n", hresult_text(hr).c_str());
            std::fflush(stderr);
        }
        if (ready) CloseHandle(ready);
    }
    if (SUCCEEDED(com)) CoUninitialize();
}

// mic.level every 50 ms with the RMS of the samples since the previous one.
void send_levels(std::shared_ptr<Session> s) {
    while (WaitForSingleObject(s->done, kLevelMs) == WAIT_TIMEOUT) {
        double squares = 0;
        size_t squared = 0;
        {
            std::lock_guard<std::mutex> hold(s->lock);
            std::swap(squares, s->squares);
            std::swap(squared, s->squared);
        }
        if (!squared || !s->live) continue;
        double rms = std::sqrt(squares / static_cast<double>(squared));
        json::Value data = json::object();
        data.set("session", json::str(s->id));
        data.set("rms", json::number(std::isfinite(rms) ? std::min(1.0, std::max(0.0, rms)) : 0.0));
        send_event("mic.level", std::move(data), s->live);
    }
}

// SenseVoice does not stream: every 600 ms the audio so far is decoded again, and a changed text is the partial.
void send_partials(std::shared_ptr<Session> s, const Sherpa* api) {
    std::string said;
    size_t decoded = 0;
    while (WaitForSingleObject(s->done, kPartialMs) == WAIT_TIMEOUT) {
        if (!s->live) continue;
        std::vector<float> audio;
        {
            std::lock_guard<std::mutex> hold(s->lock);
            if (s->audio.size() == decoded) continue;
            audio = s->audio;
        }
        decoded = audio.size();
        std::string text = transcribe(*api, audio.data(), audio.size());
        if (text == said || s->stop) continue;
        said = text;
        json::Value data = json::object();
        data.set("session", json::str(s->id));
        data.set("text", json::str(text));
        send_event("speech.partial", std::move(data), s->live);
    }
}

// Ends the session's threads; its audio stays.
void finish(const std::shared_ptr<Session>& s) {
    s->live = false;
    s->stop = true;
    SetEvent(s->done);
    SetEvent(s->go);
    for (std::thread* t : {&s->capture, &s->level_sender, &s->partial_sender}) {
        if (t->joinable()) t->join();
    }
}

// A mic.start that failed after reserving its session.
Outcome abandon(const std::shared_ptr<Session>& s, Outcome out) {
    {
        std::lock_guard<std::mutex> hold(g_mic_lock);
        if (g_current == s) g_current.reset();
    }
    finish(s);
    return out;
}

// Runs under the session lock right after mic.start's success is written: the session's events go out from now on.
void mic_answered() {
    std::lock_guard<std::mutex> hold(g_mic_lock);
    if (g_answering && g_answering == g_current) {
        g_current->answered = true;
        g_current->live = true;
    }
    g_answering.reset();
}

// The BCP-47 locale SenseVoice covers for asked's language, or empty.
std::string match_locale(const std::string& asked) {
    std::string language = ascii_lower(asked.substr(0, asked.find_first_of("-_")));
    for (const auto& locale : kLocales) {
        if (language == locale.first) return locale.second;
    }
    return {};
}

Outcome asr_unavailable(std::string why, bool retryable = false) {
    return failure("asr_unavailable", std::move(why), retryable);
}

// MARK: the hot key

enum Modifier : unsigned { kControl = 1, kAlt = 2, kShift = 4, kWin = 8 };

// One key with exactly these modifiers held, or right Alt on its own.
struct Combo {
    bool right_alt = false;
    unsigned key = 0;  // a virtual-key code
    unsigned modifiers = 0;
    bool operator==(const Combo& other) const {
        return right_alt == other.right_alt && key == other.key && modifiers == other.modifiers;
    }
};

// Config.parseHotkey's names; empty when combo is set, else why not.
std::string parse_combo(const std::string& text, Combo& combo) {
    std::string name = ascii_lower(text);
    if (name == "right_option") {
        combo.right_alt = true;
        return {};
    }
    std::vector<std::string> parts;
    for (size_t start = 0;;) {
        size_t plus = name.find('+', start);
        parts.push_back(name.substr(start, plus == std::string::npos ? std::string::npos : plus - start));
        if (plus == std::string::npos) break;
        start = plus + 1;
    }
    const std::string& key = parts.back();
    int function = key.size() >= 2 && key.size() <= 3 && key[0] == 'f' &&
                           key.find_first_not_of("0123456789", 1) == std::string::npos
                       ? std::stoi(key.substr(1))
                       : 0;
    if (key == "space") combo.key = VK_SPACE;
    else if (key.size() == 1 && key[0] >= 'a' && key[0] <= 'z') combo.key = static_cast<unsigned>('A' + (key[0] - 'a'));
    else if (key.size() == 1 && key[0] >= '0' && key[0] <= '9') combo.key = static_cast<unsigned>(key[0]);
    else if (function >= 1 && function <= 12) combo.key = static_cast<unsigned>(VK_F1 + function - 1);
    else return "the combo has a key Config.parseHotkey does not know";
    for (size_t k = 0; k + 1 < parts.size(); ++k) {
        const std::string& part = parts[k];
        if (part == "control" || part == "ctrl") combo.modifiers |= kControl;
        else if (part == "option" || part == "alt") combo.modifiers |= kAlt;
        else if (part == "shift") combo.modifiers |= kShift;
        else if (part == "command" || part == "cmd") return "the Windows key is reserved for the system";
        else return "the combo has a modifier Config.parseHotkey does not know";
    }
    return {};
}

// The watch thread and the ptt ops; the modifier keys' state is all the helper keeps of other keys.
std::mutex g_ptt_lock;
bool g_ptt_registered = false, g_ptt_down = false;
Combo g_combo;
unsigned g_held = 0;  // one bit per physical modifier key, left and right apart
std::atomic<bool> g_ptt_live{false};

unsigned held_modifiers() {
    unsigned out = 0;
    if (g_held & 0x03) out |= kControl;
    if (g_held & 0x0C) out |= kAlt;
    if (g_held & 0x30) out |= kShift;
    if (g_held & 0xC0) out |= kWin;
    return out;
}

}  // namespace

Outcome speech_locales(const json::Value&) {
    if (!sherpa()) return asr_unavailable("the sherpa-onnx DLLs beside ac-helper.exe are missing or do not load");
    json::Value locales = json::array();
    for (const auto& locale : kLocales) locales.push(json::str(locale.second));
    json::Value result = json::object();
    result.set("engine", json::str("sherpa-onnx-sensevoice"));
    result.set("locales", std::move(locales));
    return success(std::move(result));
}

Outcome mic_start(const json::Value& params) {
    uint64_t deadline = GetTickCount64() + kStartBudgetMs;
    const json::Value* transcribe_param = params.get("transcribe");
    auto s = std::make_shared<Session>();
    s->id = params.get("session")->s;
    s->transcribe = !transcribe_param || transcribe_param->b;
    s->levels = flag(params, "level_events");
    std::string locale = match_locale(params.get("locale")->s);
    if (locale.empty()) return failure("locale_unsupported", "SenseVoice has no language like the locale");
    const Sherpa* api = s->transcribe ? sherpa() : nullptr;
    if (s->transcribe && !api) {
        return asr_unavailable("the sherpa-onnx DLLs beside ac-helper.exe are missing or do not load");
    }
    if (!s->go || !s->done) return failure("internal", "cannot create the session's events");
    {
        std::lock_guard<std::mutex> hold(g_mic_lock);
        if (g_current) return failure("mic_busy", "another session is recording");
        g_current = s;
    }
    std::promise<Opened> promise;
    std::future<Opened> opened = promise.get_future();
    try {
        s->capture = std::thread(capture_thread, s, std::move(promise));
    } catch (const std::exception&) {
        return abandon(s, failure("internal", "cannot start the capture thread"));
    }
    Opened open = opened.get();
    if (!open.code.empty()) return abandon(s, failure(open.code, open.message));
    std::wstring dir = s->transcribe ? model_dir() : std::wstring();
    if (s->transcribe) {
        bool retryable = false;
        std::string problem = ensure_model(dir, deadline, &s->id, retryable);
        if (!problem.empty()) return abandon(s, asr_unavailable(problem, retryable));
    }
    // A cancel during the download leaves the microphone unstarted.
    if (!this_request()->open) return abandon(s, failure("cancelled", "the request was answered before recording"));
    // Recording starts before the recognizer's first load, which takes seconds.
    SetEvent(s->go);
    if (s->transcribe) {
        std::string problem = load_recognizer(*api, dir);
        if (!problem.empty()) return abandon(s, asr_unavailable(problem));
    }
    try {
        if (s->levels) s->level_sender = std::thread(send_levels, s);
        if (s->transcribe) s->partial_sender = std::thread(send_partials, s, api);
    } catch (const std::exception&) {
        return abandon(s, failure("internal", "cannot start the session's threads"));
    }
    if (!commit(*this_request())) return abandon(s, failure("cancelled", "the request was answered before it started"));
    {
        std::lock_guard<std::mutex> hold(g_mic_lock);
        g_answering = s;
    }
    json::Value result = json::object();
    result.set("session", json::str(s->id));
    result.set("locale", json::str(locale));
    result.set("sample_rate", json::integer(kSampleRate));
    Outcome out = success(std::move(result));
    out.answered = mic_answered;
    return out;
}

Outcome mic_stop(const json::Value& params) {
    const std::string& id = params.get("session")->s;
    std::shared_ptr<Session> s;
    {
        std::lock_guard<std::mutex> hold(g_mic_lock);
        if (!g_current || g_current->id != id || !g_current->answered) {
            return failure("not_recording", "no session with that id is recording");
        }
        s = std::move(g_current);
    }
    uint64_t stopped = GetTickCount64();
    finish(s);
    std::string text;
    const Sherpa* api = sherpa();
    if (s->transcribe && api && !flag(params, "discard")) text = transcribe(*api, s->audio.data(), s->audio.size());
    json::Value result = json::object();
    result.set("session", json::str(id));
    result.set("text", json::str(std::move(text)));
    result.set("duration_ms", json::integer(s->started_ms ? static_cast<int64_t>(stopped - s->started_ms) : 0));
    return success(std::move(result));
}

void ptt_key(unsigned vkey, unsigned make_code, unsigned flags) {
    bool up = (flags & RI_KEY_BREAK) != 0, extended = (flags & RI_KEY_E0) != 0;
    const char* event = nullptr;
    {
        std::lock_guard<std::mutex> hold(g_ptt_lock);
        unsigned bit = 0;
        if (vkey == VK_CONTROL) bit = extended ? 0x02 : 0x01;
        else if (vkey == VK_MENU) bit = extended ? 0x08 : 0x04;
        else if (vkey == VK_SHIFT) bit = make_code == 0x36 ? 0x20 : 0x10;
        else if (vkey == VK_LWIN) bit = 0x40;
        else if (vkey == VK_RWIN) bit = 0x80;
        g_held = up ? g_held & ~bit : g_held | bit;
        if (!g_ptt_registered) return;
        // AltGr's synthetic left Ctrl is another key: right_option watches right Alt alone.
        bool hit = g_combo.right_alt ? vkey == VK_MENU && extended : vkey == g_combo.key;
        if (!hit) return;
        if (!up && !g_ptt_down && (g_combo.right_alt || held_modifiers() == g_combo.modifiers)) {
            g_ptt_down = true;
            event = "ptt.down";
        } else if (up && g_ptt_down) {
            g_ptt_down = false;
            event = "ptt.up";
        }
    }
    if (event) send_event(event, json::object(), g_ptt_live);
}

Outcome ptt_register(const json::Value& params) {
    Combo wanted;
    std::string problem = parse_combo(params.get("combo")->s, wanted);
    if (!problem.empty()) return failure("bad_hotkey", problem);
    if (!keyboard_watched()) return failure("internal", "Raw Input could not be registered");
    json::Value result = json::object();
    result.set("registered", json::boolean(true));
    Outcome out = success(std::move(result));
    std::lock_guard<std::mutex> hold(g_ptt_lock);
    if (g_ptt_registered && g_combo == wanted) return out;
    // No event of the old combo follows, and none of the new one before this answer.
    g_ptt_live = false;
    g_combo = wanted;
    g_ptt_registered = true;
    g_ptt_down = false;
    out.answered = [] { g_ptt_live = true; };
    return out;
}

Outcome ptt_unregister(const json::Value&) {
    std::lock_guard<std::mutex> hold(g_ptt_lock);
    bool had = g_ptt_registered;
    g_ptt_live = false;
    g_ptt_registered = g_ptt_down = false;
    json::Value result = json::object();
    result.set("unregistered", json::boolean(had));
    return success(std::move(result));
}

int transcribe_file(const wchar_t* wav) {
    const Sherpa* api = sherpa();
    auto fail = [](const std::string& why) {
        std::fprintf(stderr, "ac-helper --transcribe: %s\n", why.c_str());
        return 1;
    };
    if (!api) return fail("the sherpa-onnx DLLs beside ac-helper.exe are missing or do not load");
    std::wstring dir = model_dir();
    bool retryable = false;
    std::string problem = ensure_model(dir, UINT64_MAX, nullptr, retryable);
    if (problem.empty()) problem = load_recognizer(*api, dir);
    if (!problem.empty()) return fail(problem);
    const SherpaOnnxWave* wave = api->read_wave(utf8(std::wstring(wav)).c_str());
    if (!wave) return fail("the WAV file does not read");
    std::string text;
    bool rate = wave->sample_rate == kSampleRate;
    if (rate) text = transcribe(*api, wave->samples, static_cast<size_t>(wave->num_samples));
    api->free_wave(wave);
    if (!rate) return fail("the WAV file is not 16 kHz");
    json::Value out = json::object();
    out.set("text", json::str(text));
    std::string line = json::dump(out) + "\n";
    std::fwrite(line.data(), 1, line.size(), stdout);
    std::fflush(stdout);
    return 0;
}
