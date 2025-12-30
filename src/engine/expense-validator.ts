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
	amountToCheck: number; // Added to avoid mutating expense.amount
	asOf: Date;
};

export class ExpenseValidator {
	public async validate(
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
				// Currency conversion failed - mark as PENDING for manual review
				alerts.push({
					code: "CURRENCY_CONVERSION_ERROR",
					message: `Failed to convert ${originalAmount.toFixed(2)} ${fromCurrency} to ${policy.baseCurrency}: ${error instanceof Error ? error.message : "Unknown error"}. Manual review required.`,
				});
				// Keep original amount - category limits won't apply correctly, but we've alerted
			}
		}

		const ctx: RuleContext = { expense, employee, policy, amountToCheck, asOf };

		// Check each rule and collect the most restrictive status
		const ageStatus = this.checkAge(ctx, alerts);
		const categoryStatus = this.checkCategoryLimit(ctx, alerts);
		const costCenterStatus = this.checkCostCenter(ctx, alerts);

		// Get the most restrictive status
		let finalStatus = this.getMostRestrictive([
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

	private checkAge(ctx: RuleContext, alerts: Alert[]): ExpenseStatus {
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

	private checkCategoryLimit(ctx: RuleContext, alerts: Alert[]): ExpenseStatus {
		const categoryPolicy = ctx.policy.categoryLimits[ctx.expense.category];

		// No policy for this category
		if (!categoryPolicy) return ExpenseStatus.APPROVED;

		// Use amountToCheck instead of ctx.expense.amount
		// > pendingUpTo => REJECTED
		if (ctx.amountToCheck > categoryPolicy.pendingUpTo) {
			alerts.push({
				code: "CATEGORY_LIMIT",
				message: `$${ctx.amountToCheck.toFixed(2)} exceeds maximum allowed ($${categoryPolicy.pendingUpTo.toFixed(2)}) for ${ctx.expense.category}.`,
			});
			return ExpenseStatus.REJECTED;
		}

		// (approvedUpTo, pendingUpTo] => PENDING
		if (ctx.amountToCheck > categoryPolicy.approvedUpTo) {
			alerts.push({
				code: "CATEGORY_LIMIT",
				message: `$${ctx.amountToCheck.toFixed(2)} exceeds auto-approval limit ($${categoryPolicy.approvedUpTo.toFixed(2)}), requires review.`,
			});
			return ExpenseStatus.PENDING;
		}

		return ExpenseStatus.APPROVED;
	}

	private checkCostCenter(ctx: RuleContext, alerts: Alert[]): ExpenseStatus {
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

	private getMostRestrictive(statuses: ExpenseStatus[]): ExpenseStatus {
		if (statuses.includes(ExpenseStatus.REJECTED))
			return ExpenseStatus.REJECTED;
		if (statuses.includes(ExpenseStatus.PENDING)) return ExpenseStatus.PENDING;
		return ExpenseStatus.APPROVED;
	}
}
