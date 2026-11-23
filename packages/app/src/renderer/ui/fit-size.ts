// Fitting a streamed picture (browser page, …) into a panel without cropping or scrolling.

export interface Size {
  width: number;
  height: number;
}

const finite = (n: number) => Number.isFinite(n);
const clamp = (n: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, n));

/**
 * The largest size with the frame's shape that fits in `box` (CSS px, whole pixels): the picture is scaled down
 * or up, never cropped and never larger than the box, so the panel has nothing to scroll. Null when unmeasurable.
 */
export function fitSize(box: Size, frame: Size): Size | null {
  const nums = [box.width, box.height, frame.width, frame.height];
  if (!nums.every(finite) || nums.some((n) => n <= 0)) return null;
  const scale = Math.min(box.width / frame.width, box.height / frame.height);
  return {
    width: clamp(Math.floor(frame.width * scale), 1, Math.floor(box.width) || 1),
    height: clamp(Math.floor(frame.height * scale), 1, Math.floor(box.height) || 1),
  };
}
