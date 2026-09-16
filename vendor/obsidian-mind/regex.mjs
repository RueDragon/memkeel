// GENERATED FILE — do not edit.
// Type-stripped from the pinned upstream `regex.ts` by `scripts/build-vendor.mjs`.
// The `.ts` file next to this one is the vendored source of record (see THIRD_PARTY.md);
// this copy exists so the published package can be imported from anywhere, including
// node_modules, where Node refuses to strip TypeScript types.

/**
 * Small regex utilities used across scripts and hooks.
 */

/**
 * Escape regex metacharacters in a string so it can be embedded safely
 * inside a `new RegExp(...)` pattern as a literal.
 */
export function escapeRegex(s        )         {
	return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
