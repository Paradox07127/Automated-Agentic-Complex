// The C12 op table and the interface between the session layer (main.cpp) and the ops.
#pragma once

#include <atomic>
#include <string>
#include <vector>

#include "json.h"

// What one op answers: a result object, or an error (CONTRACT §3).
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

struct Field {
    const char* name;
    const char* kind;  // ops.json's type notation
};

// One op of protocol/C12-platform-helper/ops.json; ops.cpp copies the table by hand.
struct OpSpec {
    const char* name;
    bool windows;  // its platforms hold windows
    std::vector<Field> params;
    std::vector<Field> optional;
    std::vector<const char*> one_of;
};

const std::vector<OpSpec>& op_specs();
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

// ops_capture.cpp
Outcome capture_window(const json::Value& params);
Outcome capture_ambient(const json::Value& params);
// One frame of the window hwnd (an HWND) without the cursor, top-down premultiplied BGRA rows of width * 4 bytes;
// empty on success, else why not. The calling thread has joined COM.
std::string grab_window_frame(void* hwnd, unsigned& width, unsigned& height, std::vector<unsigned char>& bgra);

// ops_ocr.cpp
Outcome ocr_languages(const json::Value& params);
Outcome ocr_recognize(const json::Value& params);
