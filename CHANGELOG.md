# Change Log

## 0.1.0

- Switched triggering from diagnostics to terminal shell execution output.
- Added case-insensitive terminal keyword matching with shell-error tokens.
- **0.1.4**
  - better Windows path handling (detect drive letters in remote/posix sessions)
  - added `cmd /c start` fallback for Windows playback (helps unsupported codecs/feature‑less editions)
  - additional logging for playback attempts and clearer warning messages
  - documentation updates and remote/WSL audio caveat
- Improved Windows playback reliability with multi-backend fallback and logs.
- Added `extensionKind: ["ui"]` for local audio playback in remote workspaces.

- **0.1.6**
    - added stable support for for windows 11

## 0.0.1

- Initial release.