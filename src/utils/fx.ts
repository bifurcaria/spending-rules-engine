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

async function fetchRates(
	url: string,
	context: string,
): Promise<ExchangeRates> {
	let response: Response;
	try {
		response = await fetch(url);
	} catch (error) {
		throw new Error(
			`Failed to fetch rates (${context}): ${error instanceof Error ? error.message : "Network error"}`,
		);
	}

	if (!response.ok) {
		throw new Error(
			`Exchange rate API returned ${response.status} (${context}): ${response.statusText}`,
		);
	}

	const data: LatestRatesResponse = await response.json();

	if (data.error === true) {
		throw new Error(
			`Exchange rate API error (${context}): ${data.message || "Unknown error"}${data.description ? ` - ${data.description}` : ""}`,
		);
	}

	if (!data.rates || typeof data.rates !== "object") {
		throw new Error(
			`Invalid response from exchange rate API (${context}): expected 'rates' to be an object`,
		);
	}

	return {
		base: data.base || "USD",
		rates: data.rates,
	};
}

/**
 * Fetches the latest exchange rates from Open Exchange Rates API.
 */
export async function fetchLatestRates(): Promise<ExchangeRates> {
	const url = `${process.env.OPEN_EXCHANGE_RATES_BASE_URL || "https://openexchangerates.org"}/api/latest.json?app_id=${process.env.OPEN_EXCHANGE_RATES_APP_ID}`;
	return fetchRates(url, "latest");
}

/**
 * Fetches historical exchange rates for a specific UTC date (YYYY-MM-DD).
 * @param dateKey ISO date string in the form YYYY-MM-DD
 */
export async function fetchRatesForDate(
	dateKey: string,
): Promise<ExchangeRates> {
	const url = `${process.env.OPEN_EXCHANGE_RATES_BASE_URL || "https://openexchangerates.org"}/api/historical/${dateKey}.json?app_id=${process.env.OPEN_EXCHANGE_RATES_APP_ID}`;
	return fetchRates(url, dateKey);
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
