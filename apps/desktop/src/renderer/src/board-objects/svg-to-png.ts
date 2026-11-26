/** An SVG as a PNG, drawn by this window: what an agent can look at. Base64, no larger than a big screen. */
const MOST = 4096;

export async function svgToPng(svg: string, width: number, height: number): Promise<{ png: string; width: number; height: number }> {
  if (!svg.startsWith("<svg") || !(width > 0) || !(height > 0)) throw new Error("not a picture to draw");
  const image = new Image();
  const url = URL.createObjectURL(new Blob([svg], { type: "image/svg+xml" }));
  try {
    await new Promise<void>((resolve, reject) => {
      image.onload = () => resolve();
      image.onerror = () => reject(new Error("the picture did not draw"));
      image.src = url;
    });
    const scale = Math.min(1, MOST / Math.max(width, height));
    const canvas = document.createElement("canvas");
    canvas.width = Math.max(1, Math.round(width * scale));
    canvas.height = Math.max(1, Math.round(height * scale));
    canvas.getContext("2d")!.drawImage(image, 0, 0, canvas.width, canvas.height);
    return { png: canvas.toDataURL("image/png").split(",")[1]!, width: canvas.width, height: canvas.height };
  } finally {
    URL.revokeObjectURL(url);
  }
}
