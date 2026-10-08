// Pure presentation tokens shared by monorepo plugins; no SDK or scheduling state.
// Fresh resolves these semantic references; never snapshot the active theme's RGB values.
export const BRAND_PALETTE = {
  accent: "ui.help_key_fg",
  text: "ui.popup_text_fg",
  secondary: "editor.line_number_fg",
  symbol: "syntax.function",
  icon: "syntax.type",
  demoted: "editor.line_number_fg",
  selectedBg: "ui.popup_selection_bg",
  selectedFg: "ui.popup_selection_fg",
  previewRowBg: "editor.current_line_bg",
  matchBg: "search.match_bg",
  loadingAccent: "ui.help_key_fg",
} as const;
export const LOADING_STEP_MS = 180;
export const LOADING_FRAMES = ["•··", "·•·", "··•", "·•·"] as const;
export function loadingFrame(phase: number): string {
  const index = Math.trunc(phase);
  return LOADING_FRAMES[((index % LOADING_FRAMES.length) + LOADING_FRAMES.length) % LOADING_FRAMES.length];
}
