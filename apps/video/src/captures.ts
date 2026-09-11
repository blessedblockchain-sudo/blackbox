/**
 * Which captured shots exist in public/capture (written by scripts/capture.mjs).
 * Keep this in sync after a capture run: a missing file renders a labelled
 * placeholder instead of throwing at render time.
 *
 * Filmed 2026-09-12 against devnet round #2 (3x5BZba…D8Ky) while it was live,
 * through a production build of apps/web pointed at devnet.
 */
export const CAPTURES = {
  arena: true,
  back: true,
  proof: true,
  hall: true,
  studio: true,
} as const;

export type ShotName = keyof typeof CAPTURES;
