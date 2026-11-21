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

/** Sparse formatting changes at UTF-16 offsets in the item's plain text. */
export interface TextRun { at: number; bold?: true; underline?: true; font?: FontKey }
export interface FormattedText { runs?: TextRun[] }
export const FONTS = {
  geist: ['Geist', '"Geist Variable", "Helvetica Neue", Arial, sans-serif'],
  mono: ['Geist Mono', '"Geist Mono Variable", Menlo, Consolas, monospace'],
  georgia: ['Georgia', 'Georgia, "DejaVu Serif", serif'],
  palatino: ['Palatino', 'Palatino, "Palatino Linotype", "Book Antiqua", serif'],
  times: ['Times', '"Times New Roman", Times, serif'],
  trebuchet: ['Trebuchet', '"Trebuchet MS", "Lucida Sans", sans-serif'],
  verdana: ['Verdana', 'Verdana, Geneva, sans-serif'],
  gill: ['Gill Sans', '"Gill Sans", Candara, sans-serif'],
  courier: ['Courier', '"Courier New", Courier, monospace'],
  handwritten: ['Handwritten', '"Bradley Hand", "Segoe Print", "Comic Sans MS", cursive'],
} as const;
export type FontKey = keyof typeof FONTS;

export interface NoteItem extends Base, FormattedText { type: 'note'; text: string; color: ColorKey; fs: number }
export interface TextItem extends Base, FormattedText { type: 'text'; text: string; color: ColorKey; fs: number }
export interface ShapeItem extends Base, FormattedText { type: 'shape'; shape: ShapeKind; text: string; color: ColorKey; fs: number }
export interface ImageItem extends Base { type: 'image'; blob: string }
/** points are a flat [x0, y0, x1, y1, …] list relative to the item's x/y */
export interface StrokeItem extends Base { type: 'stroke'; points: number[]; color: ColorKey; size: number }

export interface EdgeItem extends FormattedText {
  id: string; type: 'edge';
  from: string; to: string;
  label: string; color: ColorKey;
  fs: number; sw: number;
}

export type TextualItem = NoteItem | TextItem | ShapeItem;
export type NodeItem = TextualItem | ImageItem | StrokeItem;
export type Item = NodeItem | EdgeItem;
