export interface Shape {
  area(): number;
}

export function areaOf(shape: Shape): number {
  return shape.area();
}
