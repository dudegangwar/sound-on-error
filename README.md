# Sound On Error

**Sound On Error** is a lightweight VS Code extension that listens to terminal output and plays a meme sound whenever common error keywords appear.

By default, it plays the bundled `error.mp3` (`faah`). You can also configure a custom sound file.

---

## ✨ Features

- Automatically detects common error patterns in terminal output
- Plays a bundled meme sound on detection
- Supports custom audio files
- Configurable cooldown between sound plays
- Easy enable/disable toggle

---

## 📦 Installation

### From VS Code Marketplace

1. Open **Visual Studio Code**
2. Go to **Extensions**
3. Search for **Sound On Error**
4. Click **Install**

### From Command Line

```bash
code --install-extension AnujLabs.sound-on-error
```

---

## 🔍 Trigger Keywords

Sound On Error matches terminal output case-insensitively against the following keywords:

- `error:`
- `fail:`
- `failed`
- `fatal:`
- `exception`
- `traceback`
- `cannot find path`
- `no such file or directory`
- `command not found`
- `not recognized as an internal or external command`
- `because it does not exist`

If any of these appear in terminal output, the sound will play (subject to cooldown settings).

---

## 🎮 Commands

Open the Command Palette:

- `Faah: Select Custom Sound` — Choose a custom audio file
- `Faah: Clear Custom Sound` — Reset to default bundled sound
- `Faah: Play Test Sound` — Test the currently configured sound

---

## ⚙️ Settings

You can configure the extension in:

**Settings → Extensions → Sound On Error**

Available options:

- `faah.enabled` (default: `true`)  
  Enable or disable the extension.

- `faah.customSoundPath` (default: empty)  
  Path to a custom audio file.

- `faah.cooldownMs` (default: `1200`)  
  Minimum delay (in milliseconds) between sound plays.

---

## 🖥 Platform Support

- **macOS** — Uses `afplay`
- **Linux** — Tries `paplay`, `aplay`, `ffplay`, `mpg123`, `mpg321`, then `play`
- **Windows** — Uses PowerShell media playback (additional `cmd /c start` fallback added for trouble‑meeting formats)

Terminal keyword detection relies on VS Code shell integration events.

> **Note:** the extension runs on the host that executes your workspace code.  if you
> are working in a remote/WSL container the audio code will also run there.  a
> Windows path selected from the UI may not be accessible inside the container
> and, in general, remote sessions often have no sound output at all.  if you
> don't hear anything on a remote workspace make sure the extension is running
> locally or choose a file that exists in the remote environment.

---

## 📝 Notes

- Shell integration must be enabled for reliable detection.
- Very rapid error output may be rate-limited by the cooldown setting.

---

Enjoy your terminal errors — now with sound effects.
