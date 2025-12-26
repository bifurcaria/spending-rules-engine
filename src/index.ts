import type { Employee } from "./domain/employee";
import { ExpenseCategory } from "./domain/expense";
import type { Policy } from "./domain/policy";
import { ExpenseValidator } from "./engine/expense-validator";

console.log("Setting up Expense Rules Engine Skeleton...");

const engine = new ExpenseValidator();

const policy: Policy = {
	baseCurrency: "USD",
	ageLimit: {
		rejectedAfterDays: 60,
		pendingAfterDays: 30,
	},
	categoryLimits: {
		[ExpenseCategory.FOOD]: { approvedUpTo: 100, pendingUpTo: 150 },
	},
	costCenterRules: [
		{
			costCenterId: "core_engineering",
			forbiddenCategory: ExpenseCategory.FOOD,
		},
	],
};

const expense = {
	id: "1",
	amount: 120,
	currency: "USD",
	category: ExpenseCategory.FOOD,
	date: new Date(),
};

const employee: Employee = {
	id: "e_1",
	firstName: "Ada",
	lastName: "Lovelace",
	costCenterId: "core_sales",
};

console.log(engine.validate(expense, employee, policy));
