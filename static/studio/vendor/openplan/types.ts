/**
 * Adapted from the user-provided OpenPlan3D 0.9.0 source package.
 * Local changes: framework-free types/imports and exact architectural joins.
 *
 * MIT License
 *
 * Copyright (c) 2026 theLodgeStudio
 *
 * Permission is hereby granted, free of charge, to any person obtaining a copy
 * of this software and associated documentation files (the "Software"), to deal
 * in the Software without restriction, including without limitation the rights
 * to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
 * copies of the Software, and to permit persons to whom the Software is
 * furnished to do so, subject to the following conditions:
 *
 * The above copyright notice and this permission notice shall be included in all
 * copies or substantial portions of the Software.
 *
 * THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
 * IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
 * FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
 * AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
 * LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
 * OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
 * SOFTWARE.
 */
export type Point = { x: number; y: number };
export type Wall = {
  id: string; start: Point; end: Point; thickness: number; height: number; color: string;
  startHeight?: number; endHeight?: number; curvePoint?: Point;
};
export type Room = {
  id: string; name: string; walls: string[]; floorTexture: string; area: number;
  floorOpening?: boolean; color?: string; labelOffset?: Point; [key: string]: unknown;
};
export type Floor = { walls: Wall[]; rooms: Room[] };
export type Door = { position: number; width: number; height: number; swingDirection: 'left'|'right'; flipSide: boolean };
export type Window = { position: number; width: number; height: number; sillHeight: number };
export const getWallStartHeight = (wall: Wall) => wall.startHeight ?? wall.height ?? 260;
export const getWallEndHeight = (wall: Wall) => wall.endHeight ?? wall.height ?? 260;
