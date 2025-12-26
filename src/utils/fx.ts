/**
 * Converts amount from one currency to another using Open Exchange Rates API.
 */
export function convertCurrency(
	amount: number,
	_fromCurrency: string,
	_toCurrency: string,
): number {
	// For now, mock returns 2 * amount
	return 2 * amount;
}
