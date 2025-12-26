import type { Employee } from "../domain/employee";
import { type Expense, ExpenseStatus } from "../domain/expense";
import type { Policy } from "../domain/policy";
import type { Alert, ValidationResult } from "../domain/result";
import { daysBetween } from "../utils/date";

type RuleContext = {
	expense: Expense;
	employee: Employee;
	policy: Policy;
};

export class ExpenseValidator {
	public validate(
		expense: Expense,
		employee: Employee,
		policy: Policy,
	): ValidationResult {
		const ctx: RuleContext = { expense, employee, policy };
		const alerts: Alert[] = [];

		// Check each rule and collect the most restrictive status
		const ageStatus = this.checkAge(ctx, alerts);
		const categoryStatus = this.checkCategoryLimit(ctx, alerts);
		const costCenterStatus = this.checkCostCenter(ctx, alerts);

		// Get the most restrictive status
		const finalStatus = this.getMostRestrictive([
			ageStatus,
			categoryStatus,
			costCenterStatus,
		]);

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
				message: `Exceeds maximum allowed for ${ctx.expense.category}.`,
			});
			return ExpenseStatus.REJECTED;
		}

		// (approvedUpTo, pendingUpTo] => PENDING
		if (ctx.expense.amount > categoryPolicy.approvedUpTo) {
			alerts.push({
				code: "CATEGORY_LIMIT",
				message: `Exceeds auto-approval limit for ${ctx.expense.category}; requires review.`,
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
