---
name: WSL2 Android Emulator Setup
description: User runs Android Studio emulator on Windows, connects from WSL2 — required non-trivial setup to bridge ADB and network
type: reference
---

User develops in WSL2 and runs Android Studio / Android emulator on the Windows host side. Connecting the two required setup work (ADB bridge, network forwarding). This was non-trivial to get working initially.

**How to apply:** If the user needs to set up a new emulator, reconnect ADB, or debug emulator connectivity issues, ask what specifically broke rather than starting from scratch — the initial setup is already done.
