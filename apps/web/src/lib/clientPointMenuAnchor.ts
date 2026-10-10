export function createClientPointMenuAnchor(position: { x: number; y: number }) {
  return {
    getBoundingClientRect: () => ({
      x: position.x,
      y: position.y,
      width: 0,
      height: 0,
      top: position.y,
      right: position.x,
      bottom: position.y,
      left: position.x,
    }),
  };
}
