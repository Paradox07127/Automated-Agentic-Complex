# Documentation

[简体中文](README.md) · [Project README](../README.en.md)

## Using the app

- [Product guide](product.en.md) covers desktop interaction, conversations, tasks, memory, observation, and permissions.
- [Release components](components.en.md) explains portable and split builds, installation, updates, what happens when a component is missing, and the packaging tools, Electron runtime, entitlements and Windows portable directory.
- [Importing external motion](guides/motion-import.en.md) covers importing VMD, BVH, glTF, GLB, VRMA, FBX and other external motions, the retargeting limits, and MMD dances with BGM sync.
- [Browser extension](guides/browser-extension.en.md) covers Chrome tab status, optional page text, privacy controls, and setup.
- [Computer use](architecture/tool-gateway.en.md#computer-use) explains how supported sessions can request access to a specific native app window.
- [Deploying the voice service](guides/tts-deploy.en.md) covers self-hosting GPT-SoVITS and connecting it to the app.

## Developing the app

- [Repository and runtime architecture](architecture/overview.en.md) maps the source tree and communication between processes.
- [Electron shell and platform helper](architecture/shell.en.md) covers the main process, desktop panels, `ac-helper`, permission and privacy rules, and Windows differences. The renderer (the Metal host and the Windows `efw.exe`) is a private component whose source is not in the public repository.
- [Tool gateway](architecture/tool-gateway.en.md) describes how agentd authorizes, tracks, and revokes tool calls.
- [Development and releases](development.en.md) lists prerequisites, the dev console, build and test commands, Windows builds, and release steps.
- [agentd](architecture/agentd.en.md) describes the Python packages, conventions, the main character conversation, and swappable kernels.
- [Web UI](architecture/web-ui.en.md) covers the frontend layout, design rules, mocks, and verification.
- [Character package contract](../protocol/character-library/CONTRACT.md) specifies the character library and package format.
- [Character package tools and motion generation](architecture/characters.en.md) covers the build tools, the sample character library, native bundle packing, and the motion generation service.
- [Protocol index](../protocol/README.md) lists the interfaces between components.

## Runtime integration

- [Speech synthesis service](architecture/voice.en.md) covers the GPT-SoVITS service files, token, mouth cues, and cancellation.
- [TTS engine API](../protocol/C2-speech-stream/ENGINE.md) specifies the HTTP interface for alternative speech engines.
- [Harness packaging](components.en.md#harness-runtime) covers the bundled Pi runtime; Codex, Claude Code and ACP agents use the versions installed on the Mac.
