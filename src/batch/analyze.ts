import "dotenv/config";
import csv from "csv-parser";
import fs from "fs";
import path from "path";
import { z } from "zod";
import type { Employee } from "../domain/employee";
import {
	type Expense,
	ExpenseCategory,
	ExpenseStatus,
} from "../domain/expense";
import type { Policy } from "../domain/policy";
import { ExpenseValidator } from "../engine/expense-validator";
import { type ExchangeRates, fetchRatesForDate } from "../utils/fx";

// Define Zod Schema for CSV Row
const CsvRowSchema = z.object({
	gasto_id: z.string(),
	empleado_id: z.string(),
	empleado_nombre: z.string(),
	empleado_apellido: z.string(),
	empleado_cost_center: z.string(),
	categoria: z.string(),
	monto: z.coerce.number(), // Coerce string to number
	moneda: z.string(),
	fecha: z.string().datetime({ offset: true }).or(z.string()), // Accept ISO string
});

type ParsedRow = z.infer<typeof CsvRowSchema>;

type Anomaly =
	| { code: "NEGATIVE_AMOUNT"; gastoId: string; amount: number }
	| {
			code: "DUPLICATE";
			gastoId: string;
			firstGastoId: string;
			amount: number;
			currency: string;
			date: string;
	  };

function makePolicy(): Policy {
	return {
		baseCurrency: "USD",
		ageLimit: {
			rejectedAfterDays: 60,
			pendingAfterDays: 30,
		},
		categoryLimits: {
			[ExpenseCategory.FOOD]: { approvedUpTo: 100, pendingUpTo: 150 },
			[ExpenseCategory.TRANSPORT]: { approvedUpTo: 200, pendingUpTo: 200 },
		},
		costCenterRules: [
			{
				costCenterId: "core_engineering",
				forbiddenCategory: ExpenseCategory.FOOD,
			},
		],
	};
}

function toCategory(raw: string): ExpenseCategory {
	switch (raw.toLowerCase()) {
		case "food":
			return ExpenseCategory.FOOD;
		case "transport":
			return ExpenseCategory.TRANSPORT;
		case "software":
			return ExpenseCategory.SOFTWARE;
		case "lodging":
			return ExpenseCategory.LODGING;
		default:
			return ExpenseCategory.OTHER;
	}
}

function toExpense(row: ParsedRow): Expense {
	return {
		id: row.gasto_id,
		amount: row.monto,
		currency: row.moneda,
		category: toCategory(row.categoria),
		date: new Date(row.fecha),
	};
}

function toEmployee(row: ParsedRow): Employee {
	return {
		id: row.empleado_id,
		firstName: row.empleado_nombre,
		lastName: row.empleado_apellido,
		costCenterId: row.empleado_cost_center,
	};
}

async function getRatesForDate(
	dateKey: string,
	cache: Map<string, ExchangeRates>,
): Promise<ExchangeRates> {
	const cached = cache.get(dateKey);
	if (cached) return cached;
	const fetched = await fetchRatesForDate(dateKey);
	cache.set(dateKey, fetched);
	return fetched;
}

async function readCsv(filePath: string): Promise<ParsedRow[]> {
	return new Promise((resolve, reject) => {
		const rows: ParsedRow[] = [];
		fs.createReadStream(filePath)
			.pipe(csv())
			.on("data", (data: unknown) => {
				const result = CsvRowSchema.safeParse(data);
				if (result.success) {
					rows.push(result.data);
				} else {
					console.error("Invalid CSV row:", result.error);
					// Decide whether to reject or skip. Here skipping.
				}
			})
			.on("end", () => resolve(rows))
			.on("error", (err: unknown) => reject(err));
	});
}

async function main() {
	const csvPath = path.join(process.cwd(), "gastos_historicos.csv");
	if (!fs.existsSync(csvPath)) {
		throw new Error(`CSV not found at ${csvPath}`);
	}

	const rows = await readCsv(csvPath);
	const validator = new ExpenseValidator();
	const policy = makePolicy();

	const counts: Record<ExpenseStatus, number> = {
		[ExpenseStatus.APPROVED]: 0,
		[ExpenseStatus.PENDING]: 0,
		[ExpenseStatus.REJECTED]: 0,
	};
	const anomalies: Anomaly[] = [];
	const ratesCache = new Map<string, ExchangeRates>();
	const duplicateIndex = new Map<string, string>(); // key -> first gasto_id
	const alertsByExpense: string[] = [];

	for (const row of rows) {
		const expense = toExpense(row);
		const employee = toEmployee(row);

		// Anomaly: negative amount
		if (expense.amount < 0) {
			anomalies.push({
				code: "NEGATIVE_AMOUNT",
				gastoId: expense.id,
				amount: expense.amount,
			});
		}

		// Duplicate detection (strict: amount|currency|date|category|employee)
		const dupKey = [
			expense.amount,
			expense.currency,
			expense.date.toISOString(),
			expense.category,
			employee.id,
		].join("|");
		const first = duplicateIndex.get(dupKey);
		if (first) {
			anomalies.push({
				code: "DUPLICATE",
				gastoId: expense.id,
				firstGastoId: first,
				amount: expense.amount,
				currency: expense.currency,
				date: expense.date.toISOString(),
			});
		} else {
			duplicateIndex.set(dupKey, expense.id);
		}

		// Fetch rates (cached by date) and validate
		let rates: ExchangeRates | undefined;
		if (expense.currency !== policy.baseCurrency) {
			const dateKey = expense.date.toISOString().slice(0, 10);
			rates = await getRatesForDate(dateKey, ratesCache);
		}

		const result = await validator.validate(expense, employee, policy, rates);
		counts[result.status] += 1;

		if (result.alerts.length > 0) {
			const alertsText = result.alerts
				.map((a) => `[${a.code}] ${a.message}`)
				.join("\n");
			alertsByExpense.push(`- ${expense.id}: ${alertsText}`);
		}
	}

	const countSummaryLines = [
		"## Estado de los gastos",
		`- APROBADO: ${counts[ExpenseStatus.APPROVED]}`,
		`- PENDIENTE: ${counts[ExpenseStatus.PENDING]}`,
		`- RECHAZADO: ${counts[ExpenseStatus.REJECTED]}`,
	];

	const summaryLines = [
		"# ANALISIS",
		"",
		...countSummaryLines,
		"",
		"## Anomalias detectadas",
		`- Montos negativos: ${
			anomalies.filter((a) => a.code === "NEGATIVE_AMOUNT").length
		}`,
		`- Duplicados exactos: ${
			anomalies.filter((a) => a.code === "DUPLICATE").length
		}`,
		"",
		"### Desglose de anomalias",
	];

	for (const a of anomalies) {
		if (a.code === "NEGATIVE_AMOUNT") {
			summaryLines.push(
				`- NEGATIVE_AMOUNT: gasto ${a.gastoId}, monto ${a.amount}`,
			);
		} else {
			summaryLines.push(
				`- DUPLICATE: gasto ${a.gastoId} duplica ${a.firstGastoId} (${a.amount} ${a.currency} en ${a.date})`,
			);
		}
	}

	if (alertsByExpense.length > 0) {
		summaryLines.push("", "## Alertas por gasto", ...alertsByExpense);
	}

	console.log(countSummaryLines);
	const analysisPath = path.join(process.cwd(), "ANALISIS.md");
	fs.writeFileSync(analysisPath, summaryLines.join("\n"), "utf-8");
}

main().catch((err) => {
	console.error("Analyzer failed:", err);
	process.exit(1);
});
