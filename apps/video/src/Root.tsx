import { Composition } from "remotion";
import { Submission90 } from "./Submission90";
import { Extended180 } from "./Extended180";

/** 30 fps everywhere: the 90-second cut for the submission, the 3-minute cut for judging calls. */
export const FPS = 30;

export const Root: React.FC = () => (
  <>
    <Composition id="Submission90" component={Submission90} durationInFrames={90 * FPS} fps={FPS} width={1920} height={1080} />
    <Composition id="Extended180" component={Extended180} durationInFrames={180 * FPS} fps={FPS} width={1920} height={1080} />
  </>
);
