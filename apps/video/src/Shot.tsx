/**
 * A captured page shot inside the browser frame, or a labelled placeholder
 * while the capture does not exist yet.
 */
import React from "react";
import { AbsoluteFill, OffthreadVideo, staticFile } from "remotion";
import { BrowserFrame, C, MONO } from "./kit";
import { CAPTURES, type ShotName } from "./captures";

export const Shot: React.FC<{ name: ShotName; url: string; startFrom?: number; delay?: number }> = ({ name, url, startFrom = 0, delay = 0 }) => (
  <BrowserFrame url={url} delay={delay}>
    {CAPTURES[name] ? (
      <OffthreadVideo src={staticFile(`capture/${name}.mp4`)} startFrom={startFrom} muted style={{ width: "100%", height: "100%", objectFit: "cover" }} />
    ) : (
      <AbsoluteFill style={{ background: C.surface, alignItems: "center", justifyContent: "center", color: C.fgDim, fontFamily: MONO, fontSize: 26 }}>
        capture/{name}.mp4 not recorded yet
      </AbsoluteFill>
    )}
  </BrowserFrame>
);
