// From remocn's shader-mesh-gradient (https://remocn.dev, MIT, Copyright (c) 2026 Remocn), over
// paper-design/shaders (Apache-2.0). The shader's clock is the frame number, so a frame always
// draws the same.
import { MeshGradient, type MeshGradientProps } from "@paper-design/shaders-react";
import { useCallback, useState } from "react";
import { continueRender, delayRender, useCurrentFrame, useVideoConfig } from "remotion";

export function ShaderMeshGradient({ speed = 1, ...rest }: Omit<MeshGradientProps, "frame" | "ref">) {
  const frame = useCurrentFrame();
  const { fps, width, height } = useVideoConfig();
  const [handle] = useState(() => delayRender("shader-mesh-gradient"));
  const gate = useCallback((el: HTMLDivElement | null) => {
    if (el) requestAnimationFrame(() => requestAnimationFrame(() => continueRender(handle)));
  }, [handle]);
  return (
    <div ref={gate} style={{ position: "absolute", inset: 0 }}>
      <MeshGradient speed={0} frame={(frame / fps) * speed * 1000} fit="cover" width={width} height={height} {...rest} />
    </div>
  );
}
