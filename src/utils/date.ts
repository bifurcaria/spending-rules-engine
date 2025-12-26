/**
 * Returns the number of whole days between two dates (UTC day boundaries).
 * If `later` is before `earlier`, the result can be negative.
 */
export function daysBetween(earlier: Date, later: Date): number {
	const e = Date.UTC(
		earlier.getUTCFullYear(),
		earlier.getUTCMonth(),
		earlier.getUTCDate(),
	);
	const l = Date.UTC(
		later.getUTCFullYear(),
		later.getUTCMonth(),
		later.getUTCDate(),
	);
	const msPerDay = 24 * 60 * 60 * 1000;
	return Math.floor((l - e) / msPerDay);
}

