// Track the pointer so the card's light sweep follows the cursor rather than sitting
// in a fixed spot. Written straight to CSS variables so React never re-renders on
// mouse move.
export function spotOnMove(event) {
  const el = event.currentTarget;
  const rect = el.getBoundingClientRect();
  el.style.setProperty('--mx', `${((event.clientX - rect.left) / rect.width) * 100}%`);
  el.style.setProperty('--my', `${((event.clientY - rect.top) / rect.height) * 100}%`);
}