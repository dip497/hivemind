/**
 * The board, for the canvas's board nodes and arrows: react-flow renders them, so they reach the
 * window's board (useBoard) through this context rather than through node data, which stays the
 * object alone.
 */
import { createContext, useContext } from "react";
import type { Board } from "./useBoard";

export const BoardContext = createContext<Board | null>(null);

export function useBoardContext(): Board {
  const board = useContext(BoardContext);
  if (!board) throw new Error("a board object rendered outside the canvas (no BoardContext)");
  return board;
}
