import type { ExpenseStatus } from "./expense";

export interface ValidationResult {
	expenseId: string;
	status: ExpenseStatus;
	alerts: Alert[];
}

export interface Alert {
	code: string;
	message: string;
}
