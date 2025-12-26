import type { Employee } from "../domain/employee";
import { type Expense, ExpenseStatus } from "../domain/expense";
import type { Policy } from "../domain/policy";
import type { Alert, ValidationResult } from "../domain/result";
import { daysBetween } from "../utils/date";
import { convertCurrency, fetchLatestRates } from "../utils/fx";

type RuleContext = {
	expense: Expense;
	employee: Employee;
	policy: Policy;
};

export class ExpenseValidator {
	public async validate(
		expense: Expense,
		employee: Employee,
		policy: Policy,
	): Promise<ValidationResult> {
		const ctx: RuleContext = { expense, employee, policy };
		const alerts: Alert[] = [];

		// Handle currency mismatch
		if (ctx.expense.currency !== ctx.policy.baseCurrency) {
			const originalAmount = ctx.expense.amount;
			const fromCurrency = ctx.expense.currency;
			try {
				const rates = await fetchLatestRates();
				const convertedAmount = convertCurrency(
					ctx.expense.amount,
					ctx.expense.currency,
					ctx.policy.baseCurrency,
					rates,
				);
				ctx.expense.amount = convertedAmount;
				alerts.push({
					code: "CURRENCY_MISMATCH",
					message: `Converting from ${fromCurrency} to ${ctx.policy.baseCurrency}. Initial value is ${originalAmount.toFixed(2)} ${fromCurrency}, final value is ${convertedAmount.toFixed(2)} ${ctx.policy.baseCurrency}.`,
				});
			} catch (error) {
				// Currency conversion failed - mark as PENDING for manual review
				alerts.push({
					code: "CURRENCY_CONVERSION_ERROR",
					message: `Failed to convert ${originalAmount.toFixed(2)} ${fromCurrency} to ${ctx.policy.baseCurrency}: ${error instanceof Error ? error.message : "Unknown error"}. Manual review required.`,
				});
				// Keep original amount - category limits won't apply correctly, but we've alerted
			}
		}

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
		const daysOld = Math.max(0, daysBetween(ctx.expense.date, new Date()));
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

		// > pendingUpTo => REJECTED
		if (ctx.expense.amount > categoryPolicy.pendingUpTo) {
			alerts.push({
				code: "CATEGORY_LIMIT",
				message: `$${ctx.expense.amount.toFixed(2)} exceeds maximum allowed ($${categoryPolicy.pendingUpTo.toFixed(2)}) for ${ctx.expense.category}.`,
			});
			return ExpenseStatus.REJECTED;
		}

		// (approvedUpTo, pendingUpTo] => PENDING
		if (ctx.expense.amount > categoryPolicy.approvedUpTo) {
			alerts.push({
				code: "CATEGORY_LIMIT",
				message: `$${ctx.expense.amount.toFixed(2)} exceeds auto-approval limit ($${categoryPolicy.approvedUpTo.toFixed(2)}), requires review.`,
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
