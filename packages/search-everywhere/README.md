<!-- demo-video:start -->
[![Plugin demo](assets/demo.gif)](assets/demo.mp4)
<!-- demo-video:end -->

Actual Fresh PTY with fixture providers. Important completed search, selection and open screens freeze for 1.5 seconds during replay. These are presentation holds, not backend latency; raw PTY time and media time are separate in `assets/provenance.json`.

After installing the package, add this Ctrl+Alt+Space binding to `~/.config/fresh/config.json`:

```json
{
  "keybindings": [{"key": "Space", "modifiers": ["ctrl", "alt"], "action": "search_everywhere_open"}]
}
```
