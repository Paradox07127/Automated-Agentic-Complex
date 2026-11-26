// The C12 op table and the interface between the session layer (main.cpp) and the ops.
#pragma once

#include <atomic>
#include <memory>
#include <string>
#include <vector>

#include "json.h"
#include "ops_table.generated.h"

// What one op answers: a result object, or an error.
struct Outcome {
    bool ok = true;
    json::Value result;
    std::string code;
    std::string message;  // for logs; never holds what the op read
    bool retryable = false;
    void (*answered)() = nullptr;  // runs under the session lock right after the success answer is written
};

Outcome success(json::Value result);
Outcome failure(std::string code, std::string message, bool retryable = false);

// Runs on its own thread; params already passed params_error.
using Handler = Outcome (*)(const json::Value& params);

// One request in flight (main.cpp), from dispatch to its one answer.
struct Request {
    // Until it is answered, by its handler, a cancel or the shutdown; events of this request alone (speech.download)
    // go out while it holds.
    std::atomic<bool> open{true};
    bool committed = false;  // past its commit point, from which a cancel no longer stops it; under the session lock
};

// The request of the handler running on this thread; work the handler hands to another thread takes it along.
std::shared_ptr<Request> this_request();
// The commit point of an op that main.cpp's commits_itself names, right before its side effect. True:
// no cancel stops the request from now on, and it answers what its handler returns. False: it has been answered
// already (cancelled, shut down, or given up by its handler); the effect must not happen and what the handler opened
// is taken down. Every other op commits as it starts.
bool commit(Request& request);

using Field = c12_generated::Field;
// One op of protocol/C12-platform-helper/ops.json, from the generated table.
using OpSpec = c12_generated::Op;

// Its platforms hold windows.
inline bool on_windows(const OpSpec& op) { return op.platforms != c12_generated::Platforms::mac; }
const OpSpec* find_op(const std::string& name);
// Empty when params fit the op (validate.py's rules), else the first problem.
std::string params_error(const OpSpec& op, const json::Value& params);

// The handler of an op this helper implements, else nullptr (ops_win32.cpp).
Handler find_handler(const std::string& name);
// The events those ops send; hello lists them (ops_win32.cpp).
const std::vector<const char*>& event_names();

// Writes one event while live holds, checked under the session lock (main.cpp), so that nothing follows the answer
// that turned live off.
void send_event(const char* name, json::Value data, const std::atomic<bool>& live);

// ops_attention.cpp: the thread that receives the watches' notifications and counts input; main starts it.
void start_watches();
Outcome attention_sample(const json::Value& params);
Outcome presence_watch(const json::Value& params);
Outcome input_modifiers(const json::Value& params);
Outcome input_watch(const json::Value& params);
Outcome workspace_watch(const json::Value& params);
// The watch window's keyboard Raw Input is registered; ptt.register needs it.
bool keyboard_watched();

// ops_capture.cpp
Outcome capture_window(const json::Value& params);
Outcome capture_ambient(const json::Value& params);
// One frame of the window hwnd (an HWND) without the cursor, top-down premultiplied BGRA rows of width * 4 bytes;
// empty on success, else why not. The calling thread has joined COM.
std::string grab_window_frame(void* hwnd, unsigned& width, unsigned& height, std::vector<unsigned char>& bgra);

// ops_ocr.cpp
Outcome ocr_languages(const json::Value& params);
Outcome ocr_recognize(const json::Value& params);

// ops_control.cpp. control_stop closes the endpoint and deletes the token file; main calls it before
// exiting.
Outcome control_listen(const json::Value& params);
Outcome control_respond(const json::Value& params);
void control_stop();

// ops_voice.cpp
Outcome speech_locales(const json::Value& params);
Outcome mic_start(const json::Value& params);
Outcome mic_stop(const json::Value& params);
Outcome ptt_register(const json::Value& params);
Outcome ptt_unregister(const json::Value& params);
// Every keyboard Raw Input of the watch window (RAWKEYBOARD's VKey, MakeCode and Flags), on its thread.
void ptt_key(unsigned vkey, unsigned make_code, unsigned flags);
// ac-helper.exe --transcribe <wav>: the replay's check of the recognizer on a 16 kHz WAV, downloading the model when it
// is missing; prints {"text": ...} and returns the exit code.
int transcribe_file(const wchar_t* wav);
