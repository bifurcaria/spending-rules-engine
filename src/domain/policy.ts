import type { ExpenseCategory } from "./expense";

export interface Policy {
	/**
	 * Base currency in which policy thresholds are defined (e.g. "USD").
	 */
	baseCurrency: string;

	/**
	 * Expense age thresholds (in days).
	 * - 0..approvedUpToDays => APPROVED
	 * - (approvedUpToDays..pendingUpToDays] => PENDING
	 * - > pendingUpToDays => REJECTED
	 */
	ageLimit: {
		rejectedAfterDays: number;
		pendingAfterDays: number;
	};

	/**
	 * Limits per category, expressed in baseCurrency.
	 */
	categoryLimits: Partial<Record<ExpenseCategory, CategoryLimit>>;

	/**
	 * Cross-rule restrictions by cost center.
	 */
	costCenterRules: CostCenterRule[];
}

export interface CategoryLimit {
	approvedUpTo: number;
	pendingUpTo: number;
}

export interface CostCenterRule {
	costCenterId: string;
	forbiddenCategory: ExpenseCategory;
}
