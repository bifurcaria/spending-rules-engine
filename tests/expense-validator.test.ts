import { ExpenseValidator } from "../src/engine/expense-validator";
import type { Employee } from "../src/domain/employee";
import {
	type Expense,
	ExpenseCategory,
	ExpenseStatus,
} from "../src/domain/expense";
import type { Policy } from "../src/domain/policy";

function makePolicy(overrides?: Partial<Policy>): Policy {
	return {
		baseCurrency: "USD",
		ageLimit: {
			// Spec: 0..30 approved, 31..60 pending, >60 rejected
			pendingAfterDays: 30,
			rejectedAfterDays: 60,
		},
		categoryLimits: {},
		costCenterRules: [],
		...overrides,
	};
}

function makeEmployee(overrides?: Partial<Employee>): Employee {
	return {
		id: "e_1",
		firstName: "Ada",
		lastName: "Lovelace",
		costCenterId: "sales_team",
		...overrides,
	};
}

function makeExpense(overrides?: Partial<Expense>): Expense {
	return {
		id: "g_1",
		amount: 10,
		currency: "USD",
		category: ExpenseCategory.OTHER,
		date: new Date("2025-01-01T00:00:00.000Z"),
		...overrides,
	};
}

describe("ExpenseValidator (Part 1)", () => {
	const engine = new ExpenseValidator();

	beforeEach(() => {
		jest.useFakeTimers();
		jest.setSystemTime(new Date("2025-01-31T12:00:00.000Z"));
	});

	afterEach(() => {
		jest.useRealTimers();
	});

	test("age rule: APPROVED when daysOld is less than or equal to pendingAfterDays", async () => {
		const policy = makePolicy();
		const employee = makeEmployee();
		const expense = makeExpense({ date: new Date("2025-01-21T00:00:00.000Z") }); // ~10 days old

		const result = await engine.validate(expense, employee, policy);
		expect(result.status).toBe(ExpenseStatus.APPROVED);
		expect(result.alerts).toEqual([]);
	});

	test("age rule: PENDING when daysOld is between pendingAfterDays and rejectedAfterDays", async () => {
		const policy = makePolicy();
		const employee = makeEmployee();
		const expense = makeExpense({ date: new Date("2024-12-20T00:00:00.000Z") }); // ~42 days old

		const result = await engine.validate(expense, employee, policy);
		expect(result.status).toBe(ExpenseStatus.PENDING);
		expect(result.alerts.some((a) => a.code === "AGE_LIMIT")).toBe(true);
	});

	test("age rule: REJECTED when daysOld is greater than rejectedAfterDays", async () => {
		const policy = makePolicy();
		const employee = makeEmployee();
		const expense = makeExpense({ date: new Date("2024-11-01T00:00:00.000Z") }); // ~91 days old

		const result = await engine.validate(expense, employee, policy);
		expect(result.status).toBe(ExpenseStatus.REJECTED);
		expect(result.alerts.some((a) => a.code === "AGE_LIMIT")).toBe(true);
	});

	test("category limit: APPROVED when amount is less than or equal to approvedUpTo", async () => {
		const policy = makePolicy({
			categoryLimits: {
				[ExpenseCategory.FOOD]: { approvedUpTo: 100, pendingUpTo: 150 },
			},
		});
		const employee = makeEmployee();
		const expense = makeExpense({
			category: ExpenseCategory.FOOD,
			amount: 90,
		});

		const result = await engine.validate(expense, employee, policy);
		expect(result.status).toBe(ExpenseStatus.APPROVED);
		expect(result.alerts).toEqual([]);
	});

	test("category limit: PENDING when amount is between approvedUpTo and pendingUpTo", async () => {
		const policy = makePolicy({
			categoryLimits: {
				[ExpenseCategory.FOOD]: { approvedUpTo: 100, pendingUpTo: 150 },
			},
		});
		const employee = makeEmployee();
		const expense = makeExpense({
			category: ExpenseCategory.FOOD,
			amount: 120,
		});

		const result = await engine.validate(expense, employee, policy);
		expect(result.status).toBe(ExpenseStatus.PENDING);
		expect(result.alerts.some((a) => a.code === "CATEGORY_LIMIT")).toBe(true);
	});

	test("category limit: REJECTED when amount is greater than pendingUpTo", async () => {
		const policy = makePolicy({
			categoryLimits: {
				[ExpenseCategory.FOOD]: { approvedUpTo: 100, pendingUpTo: 150 },
			},
		});
		const employee = makeEmployee();
		const expense = makeExpense({
			category: ExpenseCategory.FOOD,
			amount: 160,
		});

		const result = await engine.validate(expense, employee, policy);
		expect(result.status).toBe(ExpenseStatus.REJECTED);
		expect(result.alerts.some((a) => a.code === "CATEGORY_LIMIT")).toBe(true);
	});

	test("currency conversion: converts non-base currency and applies category limits to converted amount", async () => {
		const policy = makePolicy({
			baseCurrency: "USD",
			categoryLimits: {
				[ExpenseCategory.FOOD]: { approvedUpTo: 100, pendingUpTo: 150 },
			},
		});
		const employee = makeEmployee();
		// 50 CLP -> 100 USD (mock doubles the amount)
		const expense = makeExpense({
			category: ExpenseCategory.FOOD,
			amount: 50,
			currency: "CLP",
		});

		const result = await engine.validate(expense, employee, policy);
		expect(result.status).toBe(ExpenseStatus.APPROVED); // 100 USD <= 100 approvedUpTo
		expect(result.alerts.some((a) => a.code === "CURRENCY_MISMATCH")).toBe(
			true,
		);
	});

	test("currency conversion: converted amount exceeds limits", async () => {
		const policy = makePolicy({
			baseCurrency: "USD",
			categoryLimits: {
				[ExpenseCategory.FOOD]: { approvedUpTo: 100, pendingUpTo: 150 },
			},
		});
		const employee = makeEmployee();
		// 200,000 CLP -> ~221 USD with live rates (CLP ~902/USD), exceeds pendingUpTo
		const expense = makeExpense({
			category: ExpenseCategory.FOOD,
			amount: 200_000,
			currency: "CLP",
		});

		const result = await engine.validate(expense, employee, policy);
		expect(result.status).toBe(ExpenseStatus.REJECTED); // 160 USD > 150 pendingUpTo
		expect(result.alerts.some((a) => a.code === "CURRENCY_MISMATCH")).toBe(
			true,
		);
		expect(result.alerts.some((a) => a.code === "CATEGORY_LIMIT")).toBe(true);
	});

	test("cost center cross-rule: REJECTED when forbidden category is used", async () => {
		const policy = makePolicy({
			costCenterRules: [
				{
					costCenterId: "core_engineering",
					forbiddenCategory: ExpenseCategory.FOOD,
				},
			],
		});
		const employee = makeEmployee({ costCenterId: "core_engineering" });
		const expense = makeExpense({ category: ExpenseCategory.FOOD });

		const result = await engine.validate(expense, employee, policy);
		expect(result.status).toBe(ExpenseStatus.REJECTED);
		expect(result.alerts.some((a) => a.code === "COST_CENTER_POLICY")).toBe(
			true,
		);
	});

	test("final resolution: REJECTED wins over PENDING (alerts accumulate)", async () => {
		const policy = makePolicy({
			categoryLimits: {
				[ExpenseCategory.FOOD]: { approvedUpTo: 100, pendingUpTo: 150 },
			},
			costCenterRules: [
				{
					costCenterId: "core_engineering",
					forbiddenCategory: ExpenseCategory.FOOD,
				},
			],
		});
		const employee = makeEmployee({ costCenterId: "core_engineering" });
		const expense = makeExpense({
			category: ExpenseCategory.FOOD,
			amount: 120, // would be PENDING by category limit, but cost center forces REJECTED
		});

		const result = await engine.validate(expense, employee, policy);
		expect(result.status).toBe(ExpenseStatus.REJECTED);
		expect(result.alerts.some((a) => a.code === "CATEGORY_LIMIT")).toBe(true);
		expect(result.alerts.some((a) => a.code === "COST_CENTER_POLICY")).toBe(
			true,
		);
	});
});
