"use client";
import { AnimatePresence, MotionConfig, motion } from "framer-motion";
import { BlackboxTile, type TileData } from "./blackbox-tile";

export function EntrantGrid({ tiles, sealed }: { tiles: TileData[]; sealed: boolean }) {
  return (
    <MotionConfig reducedMotion="user">
      <ol className="grid grid-cols-1 gap-2 sm:grid-cols-2 lg:grid-cols-3 2xl:grid-cols-4" aria-label="Entrants">
        <AnimatePresence initial={false}>
          {tiles.map((t) => (
            <motion.li
              key={t.owner}
              layout="position"
              initial={{ opacity: 0, y: 6 }}
              animate={{ opacity: 1, y: 0 }}
              exit={{ opacity: 0 }}
              transition={{ layout: { type: "spring", stiffness: 420, damping: 42 }, opacity: { duration: 0.25 } }}
            >
              <BlackboxTile t={t} sealed={sealed} />
            </motion.li>
          ))}
        </AnimatePresence>
      </ol>
    </MotionConfig>
  );
}
