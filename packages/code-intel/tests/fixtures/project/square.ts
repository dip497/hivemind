import { areaOf, type Shape } from "./shapes";

export class Square implements Shape {
  constructor(readonly side: number) {}
  area(): number {
    return this.side * this.side;
  }
}

export const total = areaOf(new Square(2)) + areaOf(new Square(3));
