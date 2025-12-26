import "dotenv/config";

interface LatestRatesResponse {
	base: string;
	rates: Record<string, number>;
	error?: boolean;
	message?: string;
	description?: string;
}

export interface ExchangeRates {
	base: string;
	rates: Record<string, number>;
}

/**
 * Fetches the latest exchange rates from Open Exchange Rates API.
 * @throws {Error} If the API request fails or returns an error response
 */
export async function fetchLatestRates(): Promise<ExchangeRates> {
	const url = `https://openexchangerates.org/api/latest.json?app_id=${process.env.OPEN_EXCHANGE_RATES_APP_ID}`;

	let response: Response;
	try {
		response = await fetch(url);
	} catch (error) {
		throw new Error(
			`Failed to fetch exchange rates: ${error instanceof Error ? error.message : "Network error"}`,
		);
	}

	if (!response.ok) {
		throw new Error(
			`Exchange rate API returned ${response.status}: ${response.statusText}`,
		);
	}

	const data: LatestRatesResponse = await response.json();

	// Check if API returned an error (e.g., invalid_app_id)
	if (data.error === true) {
		throw new Error(
			`Exchange rate API error: ${data.message || "Unknown error"}${data.description ? ` - ${data.description}` : ""}`,
		);
	}

	if (!data.rates || typeof data.rates !== "object") {
		throw new Error(
			`Invalid response from exchange rate API: expected 'rates' to be an object`,
		);
	}

	return {
		base: data.base || "USD",
		rates: data.rates,
	};
}

/**
 * Converts amount from one currency to another using exchange rates.
 * Works for any currency pair by converting through the base currency.
 * @throws {Error} If currency is not found in rates
 */
export function convertCurrency(
	amount: number,
	fromCurrency: string,
	toCurrency: string,
	rates: ExchangeRates,
): number {
	// Handle same currency
	if (fromCurrency === toCurrency) {
		return amount;
	}

	const base = rates.base;
	const rateMap = rates.rates;

	// Get rates (base currency has rate of 1)
	const fromRate = fromCurrency === base ? 1 : rateMap[fromCurrency];
	const toRate = toCurrency === base ? 1 : rateMap[toCurrency];

	if (fromRate === undefined) {
		throw new Error(`Currency '${fromCurrency}' not found in exchange rates`);
	}
	if (toRate === undefined) {
		throw new Error(`Currency '${toCurrency}' not found in exchange rates`);
	}

	if (fromRate === toRate) {
		return amount;
	}

	// Convert: fromCurrency -> base -> toCurrency
	return (amount / fromRate) * toRate;
}
