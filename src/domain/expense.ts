export interface Expense {
	id: string;
	amount: number;
	currency: string;
	category: ExpenseCategory;
	date: Date;
}

export enum ExpenseCategory {
	FOOD = "FOOD",
	TRANSPORT = "TRANSPORT",
	SOFTWARE = "SOFTWARE",
	OTHER = "OTHER",
}
export enum ExpenseStatus {
	APPROVED = "APPROVED",
	REJECTED = "REJECTED",
	PENDING = "PENDING",
}
