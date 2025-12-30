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
import type { Alert } from "../domain/result";
import { validateExpense } from "../engine/expense-validator";
import { type ExchangeRates, fetchRatesForDate } from "../utils/fx";

/**
 * Translates alert codes to Spanish for client-facing output.
 * The validator uses English internally; we translate here for the report.
 */
function translateAlert(alert: Alert): string {
	const translations: Record<string, (msg: string) => string> = {
		NEGATIVE_AMOUNT: () => "Monto no positivo",
		CURRENCY_MISMATCH: (msg) => {
			// Extract values from English message and rebuild in Spanish
			const match = msg.match(/Converting ([\d.]+) (\w+) --> ([\d.]+) (\w+)/);
			if (match) {
				return `Conversión: ${match[1]} ${match[2]} → ${match[3]} ${match[4]}`;
			}
			return "Conversión de moneda aplicada";
		},
		CURRENCY_CONVERSION_ERROR: () =>
			"Error de conversión de moneda, requiere revisión manual",
		AGE_LIMIT: (msg) => {
			const match = msg.match(/(\d+) days old.*Limit: (\d+)/);
			if (match) {
				return `Antigüedad: ${match[1]} días (límite: ${match[2]})`;
			}
			const reviewMatch = msg.match(/(\d+) days old/);
			if (reviewMatch) {
				return `Antigüedad: ${reviewMatch[1]} días, requiere revisión`;
			}
			return "Excede límite de antigüedad";
		},
		CATEGORY_LIMIT: (msg) => {
			if (msg.includes("exceeds maximum")) {
				const match = msg.match(
					/\$([\d.]+) exceeds maximum.*\$([\d.]+).*for (\w+)/,
				);
				if (match) {
					return `$${match[1]} excede máximo permitido ($${match[2]}) para ${match[3]}`;
				}
			}
			if (msg.includes("exceeds auto-approval")) {
				const match = msg.match(/\$([\d.]+) exceeds auto-approval.*\$([\d.]+)/);
				if (match) {
					return `$${match[1]} excede auto-aprobación ($${match[2]}), requiere revisión`;
				}
			}
			return "Excede límite de categoría";
		},
		COST_CENTER_POLICY: (msg) => {
			const match = msg.match(/Cost center '([^']+)'.*expense '([^']+)'/);
			if (match) {
				return `Centro de costo '${match[1]}' no puede reportar '${match[2]}'`;
			}
			return "Política de centro de costo violada";
		},
	};

	const translator = translations[alert.code];
	if (translator) {
		return `[${alert.code}] ${translator(alert.message)}`;
	}
	// Fallback: return original if unknown code
	return `[${alert.code}] ${alert.message}`;
}

// Define Zod Schema for CSV Row
const CsvRowSchema = z.object({
	gasto_id: z.string(),
	empleado_id: z.string(),
	empleado_nombre: z.string(),
	empleado_apellido: z.string(),
	empleado_cost_center: z.string(),
	categoria: z.string(),
	monto: z.coerce
		.number()
		.refine((n) => Number.isFinite(n), { message: "Monto debe ser un número" }),
	moneda: z.string().min(1, "Moneda requerida"),
	fecha: z.iso.date({ message: "Fecha inválida, debe ser YYYY-MM-DD" }),
});

type ParsedRow = z.infer<typeof CsvRowSchema>;
type InvalidRow = { raw: unknown; error: string };

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

async function readCsv(
	filePath: string,
): Promise<{ rows: ParsedRow[]; invalidRows: InvalidRow[] }> {
	return new Promise((resolve, reject) => {
		const rows: ParsedRow[] = [];
		const invalidRows: InvalidRow[] = [];
		fs.createReadStream(filePath)
			.pipe(csv())
			.on("data", (data: unknown) => {
				const result = CsvRowSchema.safeParse(data);
				if (result.success) {
					rows.push(result.data);
				} else {
					invalidRows.push({
						raw: data,
						error: result.error.issues.map((issue) => issue.message).join("; "),
					});
				}
			})
			.on("end", () => resolve({ rows, invalidRows }))
			.on("error", (err: unknown) => reject(err));
	});
}

async function main() {
	const csvPath = path.join(process.cwd(), "gastos_historicos.csv");
	if (!fs.existsSync(csvPath)) {
		throw new Error(`CSV not found at ${csvPath}`);
	}

	const { rows, invalidRows } = await readCsv(csvPath);
	const policy = makePolicy();
	const asOf =
		process.env.AS_OF_DATE !== undefined
			? new Date(process.env.AS_OF_DATE)
			: new Date();
	if (Number.isNaN(asOf.getTime())) {
		throw new Error(
			`Invalid AS_OF_DATE provided: ${process.env.AS_OF_DATE as string}`,
		);
	}

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

		const result = await validateExpense(
			expense,
			employee,
			policy,
			rates,
			asOf,
		);
		counts[result.status] += 1;

		if (result.alerts.length > 0) {
			const alertsText = result.alerts.map(translateAlert).join("\n");
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

	if (invalidRows.length > 0) {
		summaryLines.push(
			"",
			"## Filas inválidas omitidas",
			`- Total: ${invalidRows.length}`,
		);
		const maxInvalidToShow = 5;
		invalidRows.slice(0, maxInvalidToShow).forEach((ir, idx) => {
			summaryLines.push(
				`- ROW_${idx + 1}: ${ir.error}; raw=${JSON.stringify(ir.raw)}`,
			);
		});
		if (invalidRows.length > maxInvalidToShow) {
			summaryLines.push(
				`- ... ${invalidRows.length - maxInvalidToShow} más omitidas`,
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
