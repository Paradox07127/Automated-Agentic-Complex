@echo off
rem Builds the fbx-motion tool to %1 (an .exe path) with the Visual Studio x64 C tools, the CRT linked in; its objects go to
rem a scratch directory under %TEMP%. The embedded manifest makes the process code page UTF-8, so argv, stat and fopen take
rem the UTF-8 paths ufbx itself opens as UTF-16.
setlocal
if "%~1"=="" (echo usage: build.bat ^<output.exe^> & exit /b 1)
if not "%~2"=="" (echo usage: build.bat ^<output.exe^> & exit /b 1)
set "HERE=%~dp0"
set "OUT=%~f1"
set "VSWHERE=%ProgramFiles(x86)%\Microsoft Visual Studio\Installer\vswhere.exe"
if not exist "%VSWHERE%" (echo build.bat: vswhere.exe not found & exit /b 1)
set "WORK=%TEMP%\fbx-motion-%RANDOM%%RANDOM%"
if exist "%WORK%\" rmdir /s /q "%WORK%"
mkdir "%WORK%" || exit /b 1
rem Through a file: for /f would hand the quoted path with (x86) in it to cmd /c, which drops its quotes.
"%VSWHERE%" -latest -products * -requires Microsoft.VisualStudio.Component.VC.Tools.x86.x64 -property installationPath > "%WORK%\vs-path.txt"
set "VS="
set /p VS=<"%WORK%\vs-path.txt"
if not defined VS (echo build.bat: no Visual Studio with the C++ x64 tools & rmdir /s /q "%WORK%" & exit /b 1)
set "VSCMD_START_DIR=%WORK%"
call "%VS%\VC\Auxiliary\Build\vcvars64.bat" >nul
if errorlevel 1 (echo build.bat: vcvars64.bat failed & rmdir /s /q "%WORK%" & exit /b 1)
> "%WORK%\fbx-motion.manifest" (
    echo ^<?xml version="1.0" encoding="UTF-8" standalone="yes"?^>
    echo ^<assembly xmlns="urn:schemas-microsoft-com:asm.v1" manifestVersion="1.0"^>
    echo   ^<application xmlns="urn:schemas-microsoft-com:asm.v3"^>
    echo     ^<windowsSettings^>
    echo       ^<activeCodePage xmlns="http://schemas.microsoft.com/SMI/2019/WindowsSettings"^>UTF-8^</activeCodePage^>
    echo     ^</windowsSettings^>
    echo   ^</application^>
    echo ^</assembly^>
)
pushd "%WORK%"
cl /nologo /O2 /MT /W3 /D_CRT_SECURE_NO_WARNINGS /DUFBX_NO_SUBDIVISION /DUFBX_NO_TESSELLATION /DUFBX_NO_GEOMETRY_CACHE ^
    /DUFBX_NO_SKINNING_EVALUATION /DUFBX_NO_TRIANGULATION /DUFBX_NO_INDEX_GENERATION /DUFBX_NO_FORMAT_OBJ ^
    "%HERE%ufbx.c" "%HERE%fbx_motion.c" /Fe:fbx-motion.exe /link /MANIFEST:EMBED /MANIFESTINPUT:fbx-motion.manifest
set "CODE=%errorlevel%"
popd
if "%CODE%"=="0" copy /y "%WORK%\fbx-motion.exe" "%OUT%" >nul || set "CODE=1"
rmdir /s /q "%WORK%"
if not "%CODE%"=="0" (echo build.bat: cl failed with %CODE% & exit /b 1)
echo build.bat: built %OUT%
