// Pure presentation tokens shared by monorepo plugins; no SDK or scheduling state.
export const BRAND_PALETTE = {
  accent: [85, 230, 193] as [number, number, number],
  text: [242, 246, 252] as [number, number, number],
  secondary: [182, 194, 210] as [number, number, number],
  demoted: [164, 172, 185] as [number, number, number],
  selectedBg: [16, 44, 54] as [number, number, number],
  previewRowBg: [14, 23, 34] as [number, number, number],
  matchBg: [21, 60, 67] as [number, number, number],
  loadingAccent: [142, 185, 179] as [number, number, number],
} as const;
export const LOADING_STEP_MS = 150;
export const LOADING_FRAMES = ["◜", "◝", "◞", "◟"] as const;
export function loadingFrame(phase: number): string {
  const index = Math.trunc(phase);
  return LOADING_FRAMES[((index % LOADING_FRAMES.length) + LOADING_FRAMES.length) % LOADING_FRAMES.length];
}
