/**
 * Expense Validator Module
 *
 * Validates expenses against a configurable policy, returning a status
 * (APPROVED, PENDING, REJECTED) and a list of alerts explaining the decision.
 *
 * Validation rules:
 * - Age limit: rejects expenses older than a threshold
 * - Category limits: enforces per-category spending caps
 * - Cost center rules: blocks forbidden category/cost-center combinations
 * - Currency conversion: converts to base currency before comparing limits
 */

import type { Employee } from "../domain/employee";
import { type Expense, ExpenseStatus } from "../domain/expense";
import type { Policy } from "../domain/policy";
import type { Alert, ValidationResult } from "../domain/result";
import { daysBetween } from "../utils/date";
import { convertCurrency, type ExchangeRates } from "../utils/fx";

type RuleContext = {
	expense: Expense;
	employee: Employee;
	policy: Policy;
	amountToCheck: number;
	asOf: Date;
};

/**
 * Validates an expense against a policy and returns the result.
 */
export async function validateExpense(
	expense: Expense,
	employee: Employee,
	policy: Policy,
	rates: ExchangeRates | undefined,
	asOf: Date = new Date(),
): Promise<ValidationResult> {
	if (expense.amount <= 0) {
		const alerts: Alert[] = [
			{
				code: "NEGATIVE_AMOUNT",
				message: `Expense has non-positive amount (${expense.amount}).`,
			},
		];
		return {
			expenseId: expense.id,
			status: ExpenseStatus.REJECTED,
			alerts,
		};
	}

	let amountToCheck = expense.amount;
	const alerts: Alert[] = [];

	// Handle currency mismatch
	if (expense.currency !== policy.baseCurrency) {
		if (!rates) {
			throw new Error(
				`Exchange rates are required to convert ${expense.currency} -> ${policy.baseCurrency}`,
			);
		}
		const originalAmount = expense.amount;
		const fromCurrency = expense.currency;
		try {
			const convertedAmount = convertCurrency(
				expense.amount,
				expense.currency,
				policy.baseCurrency,
				rates,
			);
			amountToCheck = convertedAmount;
			alerts.push({
				code: "CURRENCY_MISMATCH",
				message: `Converting ${originalAmount.toFixed(2)} ${fromCurrency} --> ${convertedAmount.toFixed(2)} ${policy.baseCurrency}.`,
			});
		} catch (error) {
			alerts.push({
				code: "CURRENCY_CONVERSION_ERROR",
				message: `Failed to convert ${originalAmount.toFixed(2)} ${fromCurrency} to ${policy.baseCurrency}: ${error instanceof Error ? error.message : "Unknown error"}. Manual review required.`,
			});
		}
	}

	const ctx: RuleContext = { expense, employee, policy, amountToCheck, asOf };

	// Check each rule and collect the most restrictive status
	const ageStatus = checkAge(ctx, alerts);
	const categoryStatus = checkCategoryLimit(ctx, alerts);
	const costCenterStatus = checkCostCenter(ctx, alerts);

	// Get the most restrictive status
	let finalStatus = getMostRestrictive([
		ageStatus,
		categoryStatus,
		costCenterStatus,
	]);

	// If currency conversion failed, ensure status is at least PENDING
	if (
		alerts.some((a) => a.code === "CURRENCY_CONVERSION_ERROR") &&
		finalStatus === ExpenseStatus.APPROVED
	) {
		finalStatus = ExpenseStatus.PENDING;
	}

	return {
		expenseId: expense.id,
		status: finalStatus,
		alerts,
	};
}

// --- Internal helper functions (not exported = module-private) ---

function checkAge(ctx: RuleContext, alerts: Alert[]): ExpenseStatus {
	const daysOld = Math.max(0, daysBetween(ctx.expense.date, ctx.asOf));
	const { rejectedAfterDays, pendingAfterDays } = ctx.policy.ageLimit;

	if (daysOld > rejectedAfterDays) {
		alerts.push({
			code: "AGE_LIMIT",
			message: `Expense is ${daysOld} days old (Limit: ${rejectedAfterDays}).`,
		});
		return ExpenseStatus.REJECTED;
	}

	if (daysOld > pendingAfterDays) {
		alerts.push({
			code: "AGE_LIMIT",
			message: `Expense is ${daysOld} days old; requires review.`,
		});
		return ExpenseStatus.PENDING;
	}

	return ExpenseStatus.APPROVED;
}

function checkCategoryLimit(ctx: RuleContext, alerts: Alert[]): ExpenseStatus {
	const categoryPolicy = ctx.policy.categoryLimits[ctx.expense.category];

	if (!categoryPolicy) return ExpenseStatus.APPROVED;

	if (ctx.amountToCheck > categoryPolicy.pendingUpTo) {
		alerts.push({
			code: "CATEGORY_LIMIT",
			message: `$${ctx.amountToCheck.toFixed(2)} exceeds maximum allowed ($${categoryPolicy.pendingUpTo.toFixed(2)}) for ${ctx.expense.category}.`,
		});
		return ExpenseStatus.REJECTED;
	}

	if (ctx.amountToCheck > categoryPolicy.approvedUpTo) {
		alerts.push({
			code: "CATEGORY_LIMIT",
			message: `$${ctx.amountToCheck.toFixed(2)} exceeds auto-approval limit ($${categoryPolicy.approvedUpTo.toFixed(2)}), requires review.`,
		});
		return ExpenseStatus.PENDING;
	}

	return ExpenseStatus.APPROVED;
}

function checkCostCenter(ctx: RuleContext, alerts: Alert[]): ExpenseStatus {
	const violation = ctx.policy.costCenterRules.find(
		(r) =>
			r.costCenterId === ctx.employee.costCenterId &&
			r.forbiddenCategory === ctx.expense.category,
	);

	if (violation) {
		alerts.push({
			code: "COST_CENTER_POLICY",
			message: `Cost center '${ctx.employee.costCenterId}' is not allowed to expense '${ctx.expense.category}'.`,
		});
		return ExpenseStatus.REJECTED;
	}

	return ExpenseStatus.APPROVED;
}

function getMostRestrictive(statuses: ExpenseStatus[]): ExpenseStatus {
	if (statuses.includes(ExpenseStatus.REJECTED)) return ExpenseStatus.REJECTED;
	if (statuses.includes(ExpenseStatus.PENDING)) return ExpenseStatus.PENDING;
	return ExpenseStatus.APPROVED;
}
