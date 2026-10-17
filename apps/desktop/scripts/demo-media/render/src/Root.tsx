import { Composition } from "remotion";
import { Clip, type ClipProps } from "./Clip";

const FPS = 30;
const length = (p: ClipProps) => Math.round(Math.max(...p.story.shots.map((s) => s.end)) * FPS);

// Each clip is one composition; render.mjs passes its story and the recording's cues.
export function Root() {
  const empty = { story: { shots: [{ beat: "working", start: 0, end: 1, play: "first", camera: [{ u: 0, box: "full" }] }], captions: [] }, cues: { size: { width: 3200, height: 2000 }, phone: { width: 780, height: 1688 }, boxes: {}, shots: [] } } as unknown as ClipProps;
  return (
    <>
      {["hero", "phone"].map((id) => (
        <Composition key={id} id={id} component={Clip} fps={FPS} width={1280} height={800} durationInFrames={FPS}
          defaultProps={empty} calculateMetadata={({ props }) => ({ durationInFrames: length(props) })} />
      ))}
    </>
  );
}
