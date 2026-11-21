@echo off
rem Builds ac-helper.exe, the C12 platform helper for Windows, into <repo>\.local\build\helper-windows\.
rem Needs Visual Studio 2022 or its Build Tools with the C++ x64 tools; links system libraries only.
setlocal
set "SRC=%~dp0src"
for %%i in ("%~dp0..\..\..") do set "OUT=%%~fi\.local\build\helper-windows"
set "VSWHERE=%ProgramFiles(x86)%\Microsoft Visual Studio\Installer\vswhere.exe"
if not exist "%VSWHERE%" (echo build.bat: vswhere.exe not found & exit /b 1)
if not exist "%OUT%\" mkdir "%OUT%"
rem Through a file: for /f would hand the quoted path with (x86) in it to cmd /c, which drops its quotes.
"%VSWHERE%" -latest -products * -requires Microsoft.VisualStudio.Component.VC.Tools.x86.x64 -property installationPath > "%OUT%\vs-path.txt"
set "VS="
set /p VS=<"%OUT%\vs-path.txt"
if not defined VS (echo build.bat: no Visual Studio with the C++ x64 tools & exit /b 1)
call "%VS%\VC\Auxiliary\Build\vcvars64.bat" >nul
if errorlevel 1 (echo build.bat: vcvars64.bat failed & exit /b 1)
pushd "%OUT%"
cl /nologo /std:c++17 /O2 /MT /EHsc /W4 /utf-8 /DUNICODE /D_UNICODE /DWINVER=0x0A00 /D_WIN32_WINNT=0x0A00 "%SRC%\*.cpp" /Fe:ac-helper.exe /link user32.lib advapi32.lib dwmapi.lib shcore.lib version.lib ole32.lib shell32.lib uuid.lib wtsapi32.lib pdh.lib d3d11.lib windowscodecs.lib runtimeobject.lib magnification.lib
set "CODE=%errorlevel%"
popd
if not "%CODE%"=="0" (echo build.bat: cl failed with %CODE% & exit /b 1)
echo build.bat: built %OUT%\ac-helper.exe
