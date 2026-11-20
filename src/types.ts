export type ColorKey = 'ink' | 'gray' | 'red' | 'orange' | 'yellow' | 'green' | 'blue' | 'purple';
export const COLORS: ColorKey[] = ['ink', 'gray', 'red', 'orange', 'yellow', 'green', 'blue', 'purple'];

export type ShapeKind = 'ellipse' | 'pill' | 'rect' | 'diamond';
export const SHAPES: ShapeKind[] = ['ellipse', 'pill', 'rect', 'diamond'];

export type Tool =
  | 'select' | 'hand' | 'pen' | 'eraser'
  | 'note' | 'text' | 'ellipse' | 'rect' | 'diamond' | 'connect';

export interface Box { x: number; y: number; w: number; h: number }
export interface Pt { x: number; y: number }
export interface Camera { x: number; y: number; z: number }

interface Base extends Box { id: string }

export interface NoteItem extends Base { type: 'note'; text: string; color: ColorKey; fs: number }
export interface TextItem extends Base { type: 'text'; text: string; color: ColorKey; fs: number }
export interface ShapeItem extends Base { type: 'shape'; shape: ShapeKind; text: string; color: ColorKey; fs: number }
export interface ImageItem extends Base { type: 'image'; blob: string }
/** points are a flat [x0, y0, x1, y1, …] list relative to the item's x/y */
export interface StrokeItem extends Base { type: 'stroke'; points: number[]; color: ColorKey; size: number }

export interface EdgeItem {
  id: string; type: 'edge';
  from: string; to: string;
  label: string; color: ColorKey;
  fs: number; sw: number;
}

export type TextualItem = NoteItem | TextItem | ShapeItem;
export type NodeItem = TextualItem | ImageItem | StrokeItem;
export type Item = NodeItem | EdgeItem;
