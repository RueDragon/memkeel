// The one place that knows how a managed block is delimited.
//
// These markers are a control sequence, not prose. `managed` finds the single block in a note by
// them, and refuses a note that appears to hold more than one. The content it writes is arbitrary -
// event bodies, fact text, evidence lists, a user's own words - so it can mention the markers by
// accident, and a marker inside the content forges a second block. The note then becomes
// unmanageable for good: every later write refuses with "exactly one managed block", and nothing in
// the tool can repair it. That is not hypothetical: a fact body that quoted the markers deadlocked a
// live store on 2026-09-17, and the note had to be repaired by hand.
//
// Content is therefore escaped before it goes inside a block. The escaped form contains neither
// marker, so it cannot forge anything, and escaping is idempotent: escaping already-escaped text
// changes nothing because the marker is no longer present to match.
export const MANAGED_START = '<!-- AUTO-MANAGED:START -->';
export const MANAGED_END = '<!-- AUTO-MANAGED:END -->';

const ESCAPED_START = '&lt;!-- AUTO-MANAGED:START --&gt;';
const ESCAPED_END = '&lt;!-- AUTO-MANAGED:END --&gt;';

export function escapeManagedMarkers(text) {
  return String(text ?? '')
    .split(MANAGED_START).join(ESCAPED_START)
    .split(MANAGED_END).join(ESCAPED_END);
}
